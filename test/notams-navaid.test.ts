import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { isNotamAirportSnapshot, isNotamNavaidQuery, isNotamNavaidSnapshot, isNotamSnapshot, notamQueryKey,
  NOTAM_REFRESH_MS, type GeoPointFeature } from '@zlayer/contracts';
import { navaidNotamContext, partitionNavaidNotams } from '../src/layers/notams/navaid';
import { createNotamsClient } from '../src/layers/notams/client';
import { createNotamService } from '../tools/info-server/notams/service';
import { createNotamResponder } from '../tools/info-server/notams/routes';
import { NotamStore } from '../tools/info-server/notams/store';
import { collectNotamRecords } from '../tools/info-server/notams/collection';
import { recordWithRevision } from '../tools/info-server/notams/normalize';
import { notice, notamSnapshot, navaidSnapshot, NOTAM_NOW } from './fixtures/notams';

const navaids: GeoPointFeature[] = JSON.parse(await readFile(new URL('./fixtures/id-navaids.json', import.meta.url), 'utf8')).features;
const ehf = navaids.find(feature => feature.properties.ident === 'EHF')!;
const context = navaidNotamContext(ehf)!;
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function navNotice(text: string, id = '1757600000000001', location = 'EHF') {
  return notice({ id, sourceId: id, text, locations: [location], icaoLocations: [], accountability: 'BFL',
    translations: [{ type: 'LOCAL_FORMAT', text: `!BFL 10/001 ${location} ${text} 2610041159-2610051200` }] });
}

test('navaid identities use the affected NASR station, never its accountability office or an airport alias', () => {
  assert.equal(ehf.properties.notamId, 'BFL');
  assert.deepEqual(context, { query: { navaidId: 'EHF' }, type: 'VORTAC' });
  for (const feature of navaids) assert.equal(navaidNotamContext(feature)?.query.navaidId, feature.properties.ident);
  for (const properties of [{ ...ehf.properties, country: 'CA' }, { ...ehf.properties, country: undefined },
    { ...ehf.properties, kind: 'airport' }, { ...ehf.properties, ident: '' }]) {
    assert.equal(navaidNotamContext({ ...ehf, properties }), undefined);
  }
  assert.deepEqual(navaidNotamContext({ ...ehf, properties: { ...ehf.properties, ident: ' ab ', type: 'NDB-DME' } }),
    { query: { navaidId: 'AB' }, type: 'NDB/DME' });
  assert.ok(isNotamNavaidQuery({ navaidId: 'AB' }));
  for (const query of [{}, { faaId: 'EHF' }, { navaidId: 'ehf' }, { navaidId: 'E' }, { navaidId: 'ABCDEF' },
    { navaidId: 'EHF', icaoId: 'KEHF' }, { navaidId: 'EHF', notamId: 'BFL' }]) assert.equal(isNotamNavaidQuery(query), false);
  assert.notEqual(notamQueryKey({ faaId: 'EHF' }), notamQueryKey({ navaidId: 'EHF' }));
  assert.ok(isNotamNavaidSnapshot(navaidSnapshot()));
  assert.equal(isNotamAirportSnapshot(navaidSnapshot()), false);
  assert.ok(isNotamSnapshot(navaidSnapshot([], { associationCoverage: 'incomplete' })), 'older saved and server responses remain readable');
  assert.equal(isNotamSnapshot({ ...navaidSnapshot(), associationCoverage: 'unknown' }), false);
  assert.equal(isNotamSnapshot({ ...navaidSnapshot(), query: { faaId: 'EHF' } }), false);
  assert.equal(isNotamSnapshot({ ...notamSnapshot(), query: { navaidId: 'EHF' } }), false);
});

test('station components are associated conservatively; every other location notice remains available', () => {
  const related = ['NAV VORTAC U/S', 'NAV VOR NOT MNT', 'NAV EHF DME U/S', 'NAV TACAN AZM U/S',
    'NAV VOR 090-120 BEYOND 20NM UNUSABLE', 'COM VOR VOICE U/S'].map(text => navNotice(text));
  const other = ['NAV ILS RWY 30L U/S', 'RWY 09 CLSD', 'NAV NEW EQUIPMENT RESTRICTION',
    'NAV GMN VOR U/S', 'NAV NDB U/S', 'COM VOR DATA U/S', 'IAP TEST. MISSED APPROACH EHF VORTAC NA.',
    'NAV VOR/DME U/S'].map(text => navNotice(text));
  other.push(navNotice('NAV VOR U/S', '1757600000000002', 'BFL'));
  const input = [...related, ...other], original = JSON.stringify(input);
  const partition = partitionNavaidNotams(input, context);
  assert.deepEqual(partition.related, related); assert.deepEqual(partition.other, other);
  assert.equal(partition.related.length + partition.other.length, input.length);
  assert.equal(JSON.stringify(input), original, 'source text and identity are not rewritten');
  const ndb = { query: { navaidId: 'AB' }, type: 'NDB/DME' };
  assert.equal(partitionNavaidNotams([navNotice('NAV NDB U/S', undefined, 'AB'), navNotice('NAV DME U/S', undefined, 'AB')], ndb).related.length, 2);
});

test('navaid coverage is complete within station scope while airport notices and collection gaps stay distinct', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-navaid-coverage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = NOTAM_NOW;
  const station = navNotice('NAV VOR U/S');
  const airport = navNotice('IAP TEST. MISSED APPROACH EHF VORTAC NA.', '1757600000000002', 'BFL');
  const store = new NotamStore(join(directory, 'production'), 'production', () => now);
  await store.restore();
  await store.publish({ schemaVersion: 2, environment: 'production', records: [station, airport], issues: [],
    checkedAt: now, watermark: now, fullSyncAt: now, baselineAt: now, complete: true });
  await store.close();
  const service = createNotamService({ enabled: true, environment: 'production', directory,
    credentials: { clientId: 'fixture', clientSecret: 'fixture' } }, {
    signal: new AbortController().signal, now: () => now, fetch: async () => assert.fail('Station reads must not contact FAA'),
  });
  t.after(service.close); await service.restore();
  const responder = createNotamResponder(service);
  const snapshot = JSON.parse(responder.read('/api/notams/navaids?navaidId=EHF', undefined).body.toString());
  assert.ok(isNotamNavaidSnapshot(snapshot));
  assert.equal(snapshot.associationCoverage, 'incomplete'); assert.equal(snapshot.contentCoverage, 'complete');
  assert.deepEqual(snapshot.records, [station]); assert.deepEqual(snapshot.issues, []);
  assert.deepEqual(service.readAirport({ faaId: 'BFL' })?.records, [airport]);
  now += 26 * 60 * 60_000;
  const gap = JSON.parse(responder.read('/api/notams/navaids?navaidId=EHF', undefined).body.toString());
  assert.ok(isNotamNavaidSnapshot(gap));
  assert.equal(gap.associationCoverage, 'incomplete'); assert.equal(gap.contentCoverage, 'incomplete');
  assert.deepEqual(gap.records, [station]);
});

test('navaid HTTP snapshots read the existing generation, preserve unresolved evidence and cannot spend FAA quota', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-navaid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = NOTAM_NOW, calls = 0;
  const store = new NotamStore(join(directory, 'production'), 'production', () => now);
  await store.restore();
  const records = [navNotice('NAV VOR U/S'), navNotice('RWY 09 CLSD', '1757600000000002'),
    navNotice('NAV VOR U/S', '1757600000000003', 'BFL'), navNotice('NAV NDB U/S', '1757600000000004', 'AB')];
  const { revision: _revision, ...facts } = navNotice('NAV DME U/S', '1757600000000005');
  const conflict = collectNotamRecords({ records: [recordWithRevision(facts)] }, [recordWithRevision({ ...facts, text: 'NAV DME NOT MNT' })]);
  const { revision: _otherRevision, ...unscoped } = navNotice('NAV VOR U/S', '1757600000000006');
  const global = collectNotamRecords({ records: [recordWithRevision({ ...unscoped, locations: [] })] },
    [recordWithRevision({ ...unscoped, locations: [], text: 'NAV VOR NOT MNT' })]);
  await store.publish({ schemaVersion: 2, environment: 'production', records, issues: [...conflict.issues!, ...global.issues!],
    checkedAt: now, watermark: now, fullSyncAt: now, baselineAt: now, complete: true });
  await store.close();
  const service = createNotamService({ enabled: true, environment: 'production', directory,
    credentials: { clientId: 'fixture', clientSecret: 'fixture' } }, {
    signal: new AbortController().signal, now: () => now, fetch: async () => { calls++; throw new Error('No FAA reads expected'); },
  });
  t.after(service.close); await service.restore();
  const responder = createNotamResponder(service);
  const response = responder.read('/api/notams/navaids?navaidId=ehf', undefined);
  assert.equal(response.status, 200);
  const snapshot = JSON.parse(gunzipSync(await responder.encoded(response)).toString());
  assert.ok(isNotamNavaidSnapshot(snapshot));
  assert.deepEqual(snapshot.records.map(record => record.id).sort(), records.slice(0, 2).map(record => record.id));
  assert.deepEqual(snapshot.issues?.map(issue => issue.id).sort(), ['1757600000000005', '1757600000000006']);
  assert.equal(snapshot.contentCoverage, 'incomplete'); assert.equal(snapshot.associationCoverage, 'incomplete');
  assert.deepEqual(snapshot.records[0]?.translations, records[0]?.translations);
  assert.equal(responder.read('/api/notams/navaids?navaidId=EHF', undefined), response);
  const airport = JSON.parse(responder.read('/api/notams/airports?faaId=EHF', undefined).body.toString());
  assert.ok(isNotamAirportSnapshot(airport)); assert.equal(responder.stats.entries, 2);
  const ndb = JSON.parse(responder.read('/api/notams/navaids?navaidId=AB', undefined).body.toString());
  assert.ok(isNotamNavaidSnapshot(ndb)); assert.equal(ndb.records[0]?.id, records[3]?.id);
  for (const query of ['', 'navaidId=', 'navaidId=EHF&navaidId=EHF', 'faaId=EHF', 'navaidId=EHF&icaoId=KEHF', 'navaidId=EHF&refresh=1']) {
    assert.equal(responder.read(`/api/notams/navaids?${query}`, undefined).status, 400);
  }
  now += 2 * NOTAM_REFRESH_MS;
  const stale = JSON.parse(responder.read('/api/notams/navaids?navaidId=EHF', undefined).body.toString());
  assert.equal(stale.feed.state, 'degraded'); assert.equal(stale.feed.checkedAt, NOTAM_NOW);
  assert.equal(calls, 0);
});

test('shared client isolates airport/navaid caches, coalesces station demand and retains offline data on wrong-scope replies', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: NOTAM_NOW });
  const airport = notamSnapshot([], { query: { faaId: 'TST' } }), navaid = navaidSnapshot([navNotice('NAV VOR U/S', undefined, 'TST')]);
  let wrong = false; const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string, options: RequestInit) => {
    assert.equal(options.cache, 'no-store'); calls.push(input);
    assert.ok(['/api/notams/navaids?navaidId=TST', '/api/notams/airports?faaId=TST'].includes(input));
    return Response.json(input.startsWith('/api/notams/navaids?') && !wrong ? navaid : airport);
  });
  const client = createNotamsClient({ debounceMs: 0, storage: { read: () => [airport, navaid], async update() { return true; } } });
  client.start(); t.after(client.stop);
  const navKey = notamQueryKey(navaid.query), airportKey = notamQueryKey(airport.query);
  const offline = client.retain(navaid.query, false);
  t.mock.timers.tick(0); await flush(); assert.equal(calls.length, 0);
  assert.deepEqual(client.state.getSnapshot().queries[navKey]?.snapshot, navaid); offline();
  const releases = [client.retain(navaid.query, true), client.retain(navaid.query, true), client.retain(airport.query, true)];
  t.mock.timers.tick(0); await flush();
  assert.deepEqual([...calls].sort(), ['/api/notams/airports?faaId=TST', '/api/notams/navaids?navaidId=TST']);
  assert.deepEqual(client.state.getSnapshot().queries[airportKey]?.snapshot, airport);
  wrong = true; client.retry(); t.mock.timers.tick(0); await flush();
  assert.ok(client.state.getSnapshot().queries[navKey]?.error);
  assert.deepEqual(client.state.getSnapshot().queries[navKey]?.snapshot, navaid);
  assert.equal(client.state.getSnapshot().queries[airportKey]?.error, undefined);
  releases.forEach(release => release());
  const count = calls.length; t.mock.timers.tick(2 * NOTAM_REFRESH_MS); await flush(); assert.equal(calls.length, count);
});
