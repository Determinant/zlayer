import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { isNotamRegionQuery, isNotamRegionSnapshot, isNotamSnapshot, notamQueryKey, NOTAM_REFRESH_MS,
  type NotamRegionSnapshot, type NotamSnapshot } from '@zlayer/contracts';
import { airportNotamRegion } from '../src/layers/notams/region';
import { createNotamsClient } from '../src/layers/notams/client';
import { createNotamService } from '../tools/info-server/notams/service';
import { createNotamResponder } from '../tools/info-server/notams/routes';
import { NotamStore } from '../tools/info-server/notams/store';
import { notice, notamSnapshot, NOTAM_NOW } from './fixtures/notams';

test('airport regional lookup uses explicit published associations, including non-CONUS centers', () => {
  for (const id of ['ZOA', 'ZAN', 'ZHN', 'ZSU', 'ZUA']) {
    assert.deepEqual(airportNotamRegion({ country: 'US', responsibleArtcc: ` ${id.toLowerCase()} ` }), { artccId: id });
  }
  assert.deepEqual(airportNotamRegion({ country: 'US', responsibleArtcc: 'ZAN', firId: 'PAZA' }), { artccId: 'ZAN', firId: 'PAZA' });
  for (const properties of [{ country: 'US', faaId: 'ZOA', icaoId: 'KZOA', lowArtcc: 'ZOA', notamId: 'ZOA' },
    { country: 'US', centerFrequencies: [{ type: 'CENTER' as const, frequencyMHz: 127.95, facilityId: 'ZOA' }] },
    { country: 'CA', responsibleArtcc: 'ZOA' }, { country: 'US', responsibleArtcc: 'KZOA' }]) {
    assert.equal(airportNotamRegion(properties), undefined);
  }
  assert.ok(isNotamRegionQuery({ firId: 'PAZA' }));
  for (const query of [{}, { artccId: 'KZOA' }, { artccId: 'zoa' }, { artccId: 'ZOA', faaId: 'SFO' },
    { firId: 'ZOA' }, { artccId: 'ZOA', navaidId: 'ZOA' }, { firId: '' }]) assert.equal(isNotamRegionQuery(query), false);
  assert.notEqual(notamQueryKey({ artccId: 'ZOA' }), notamQueryKey({ faaId: 'ZOA' }));
  assert.notEqual(notamQueryKey({ artccId: 'ZOA' }), notamQueryKey({ navaidId: 'ZOA' }));
  assert.notEqual(notamQueryKey({ firId: 'KZOA' }), notamQueryKey({ icaoId: 'KZOA' }));
});

test('regional queries union explicit domestic/FIR selectors, retain issues, and never trigger FAA collection', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-region-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const make = (number: number, locations: string[], icaoLocations: string[] = [], classification = 'DOMESTIC') =>
    notice({ id: String(number).padStart(16, '0'), sourceId: String(number).padStart(16, '0'), locations, icaoLocations,
      classification, accountability: 'ZAN', translations: [], text: 'AIRSPACE UAS WI AN AREA DEFINED AS 2NM RADIUS OF 610000N1500000W' });
  const records = [make(1, ['ZAN']), make(2, [], ['PAZA'], 'INTL'), make(3, ['ZAN'], ['PAZA'], 'FDC'),
    make(4, ['ANC']), make(5, [], ['KZAN']), make(6, ['ZOA'])];
  const issueRecord = make(7, ['ZAN']);
  const unscopedRecord = make(8, []);
  const issues = [issueRecord, unscopedRecord].map(record => ({ id: record.id, reason: 'unsupported-lifecycle' as const,
    variants: [{ ...record, lifecycle: 'unknown' as const }], variantsTruncated: false,
    locations: record.locations, icaoLocations: [], unscoped: !record.locations.length }));
  const store = new NotamStore(join(directory, 'production'), 'production', () => NOTAM_NOW);
  await store.restore();
  await store.publish({ schemaVersion: 2, environment: 'production', records, issues,
    checkedAt: NOTAM_NOW, watermark: NOTAM_NOW, fullSyncAt: NOTAM_NOW, baselineAt: NOTAM_NOW, complete: true });
  await store.close();
  let sourceCalls = 0;
  const service = createNotamService({ enabled: true, environment: 'production', directory,
    credentials: { clientId: 'fixture', clientSecret: 'fixture' } }, { signal: new AbortController().signal, now: () => NOTAM_NOW,
    fetch: async () => { sourceCalls++; throw new Error('Unexpected FAA request'); } });
  t.after(service.close); await service.restore();
  const responder = createNotamResponder(service);
  const response = responder.read('/api/notams/regions?artccId=zan&firId=paza', undefined);
  assert.equal(response.status, 200);
  const snapshot = JSON.parse(gunzipSync(await responder.encoded(response)).toString());
  assert.ok(isNotamRegionSnapshot(snapshot));
  assert.deepEqual(snapshot.records.map(record => record.id).sort(), records.slice(0, 3).map(record => record.id));
  assert.deepEqual(snapshot.issues?.map(issue => issue.id).sort(), issues.map(issue => issue.id));
  assert.equal(snapshot.contentCoverage, 'incomplete');
  assert.equal(snapshot.associationCoverage, 'complete');
  assert.equal(isNotamSnapshot({ ...snapshot, scope: 'airport-location' }), false);
  assert.equal(isNotamSnapshot({ ...snapshot, query: { faaId: 'ZAN' } }), false);
  const domestic = service.readRegion({ artccId: 'ZAN' })!;
  assert.deepEqual(domestic.records.map(record => record.id).sort(), [records[0]!.id, records[2]!.id]);
  assert.equal(service.readRegion({ firId: 'PAZA' })!.records.length, 2);
  assert.equal(service.readRegion({ firId: 'PAZA' })!.associationCoverage, 'incomplete');
  assert.equal(service.readAirport({ faaId: 'ANC' })!.records.length, 1);
  assert.equal(responder.read('/api/notams/regions?firId=PAZA&artccId=ZAN', undefined), response);
  for (const query of ['', 'artccId=', 'artccId=ZAN&artccId=ZAN', 'artccId=ZAN&faaId=ANC', 'firId=ZAN', 'artccId=KZAN', 'navaidId=ZAN']) {
    assert.equal(responder.read(`/api/notams/regions?${query}`, undefined).status, 400);
  }
  assert.equal(sourceCalls, 0);
});

test('airports in one ARTCC share requests, memory and saved snapshots, retaining data on a wrong-scope reply', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: NOTAM_NOW });
  const regional: NotamRegionSnapshot = { ...notamSnapshot(), query: { artccId: 'ZOA' }, scope: 'region-location', associationCoverage: 'incomplete' };
  const airport = notamSnapshot([], { query: { faaId: 'ZOA' } });
  let wrong = false, writes = 0; const calls: string[] = [];
  let saved: NotamSnapshot[] = [airport, regional];
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    calls.push(input); assert.equal(input, '/api/notams/regions?artccId=ZOA');
    return Response.json(wrong ? airport : regional);
  });
  const client = createNotamsClient({ debounceMs: 0, storage: { read: () => saved,
    async update(merge) { saved = merge(saved); writes++; return true; } } });
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  client.start(); t.after(client.stop);
  const key = notamQueryKey(regional.query), offline = client.retain(regional.query, false);
  t.mock.timers.tick(0); await flush(); assert.equal(calls.length, 0);
  assert.deepEqual(client.state.getSnapshot().queries[key]?.snapshot, regional); offline();
  const queries = ['OAK', 'SFO', 'SJC'].map(faaId => airportNotamRegion({ country: 'US', faaId, icaoId: `K${faaId}`, responsibleArtcc: 'ZOA' })!);
  const releases = queries.map(query => client.retain(query, true));
  t.mock.timers.tick(0); await flush(); assert.equal(calls.length, 1);
  assert.equal(writes, 1); assert.equal(saved.filter(isNotamRegionSnapshot).length, 1);
  assert.deepEqual(Object.keys(client.state.getSnapshot().queries).sort(), [notamQueryKey(airport.query), key].sort());
  const shared = client.state.getSnapshot().queries[key]?.snapshot;
  releases.forEach(release => release());
  t.mock.timers.tick(60_000);
  const reopen = client.retain(queries[1]!, true);
  t.mock.timers.tick(0); await flush();
  assert.equal(calls.length, 1); assert.equal(writes, 1);
  assert.equal(client.state.getSnapshot().queries[key]?.snapshot, shared, 'another airport reuses the same snapshot object');
  t.mock.timers.tick(NOTAM_REFRESH_MS - 60_000); await flush();
  assert.equal(calls.length, 2); assert.equal(writes, 2);
  assert.equal(saved.filter(isNotamRegionSnapshot).length, 1, 'scheduled refresh replaces the shared saved snapshot');
  wrong = true; client.retry(); t.mock.timers.tick(0); await flush();
  assert.deepEqual(client.state.getSnapshot().queries[key]?.snapshot, regional);
  assert.match(client.state.getSnapshot().queries[key]?.error ?? '', /Unable to refresh/);
  assert.deepEqual(client.state.getSnapshot().queries[notamQueryKey(airport.query)]?.snapshot, airport);
  assert.equal(writes, 2); reopen();
});
