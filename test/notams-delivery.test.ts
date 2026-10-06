import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync, gunzipSync } from 'node:zlib';
import { isNotamAirportSnapshot, isNotamNavaidSnapshot } from '@zlayer/contracts';
import { createNotamResponder } from '../tools/info-server/notams/routes';
import { collectNotamRecords } from '../tools/info-server/notams/collection';
import { recordWithRevision } from '../tools/info-server/notams/normalize';
import { NotamStore } from '../tools/info-server/notams/store';
import { createInfoServer } from '../tools/info-server/server';
import { notice, notamSnapshot, NOTAM_NOW } from './fixtures/notams';

test('ten thousand airport readers share serialization and concurrent gzip without losing source fields', async () => {
  const records = [notice({ text: 'Quoted "source"\nUnicode: é 空 ✈\t', translations: [] })];
  let reads = 0, encodes = 0;
  const snapshot = notamSnapshot(records), responder = createNotamResponder({ readRegion() { throw new Error('Unexpected regional query'); }, readNavaid() { throw new Error('Unexpected navaid query'); },
    get status() { return snapshot.feed; },
    readAirport(query) { reads++; return { ...snapshot, query }; },
  }, async body => { encodes++; return gzipSync(body); });
  const first = responder.read('/api/notams/airports?faaId=TST&icaoId=KTST', undefined);
  for (let i = 0; i < 10_000; i++) assert.equal(responder.read('/api/notams/airports?icaoId=ktst&faaId=tst', undefined), first);
  assert.equal(reads, 1);
  const compressed = await Promise.all(Array.from({ length: 1000 }, () => responder.encoded(first)));
  assert.equal(encodes, 1); assert.ok(compressed.every(value => value === compressed[0]));
  const parsed = JSON.parse(gunzipSync(compressed[0]!).toString());
  assert.ok(isNotamAirportSnapshot(parsed)); assert.deepEqual(parsed.records, records);
});

test('cached replies follow freshness, recovery and backoff changes even when content identity is unchanged', () => {
  const snapshot = notamSnapshot([notice()]); let feed = snapshot.feed, reads = 0;
  const responder = createNotamResponder({ readRegion() { throw new Error('Unexpected regional query'); }, readNavaid() { throw new Error('Unexpected navaid query'); }, get status() { return feed; }, readAirport(query) { reads++; return { ...snapshot, feed, query }; } });
  const read = () => JSON.parse(responder.read('/api/notams/airports?faaId=TST', undefined).body.toString());
  assert.equal(read().feed.state, 'ready');
  feed = { ...feed, state: 'degraded', error: 'source-backoff', nextAttemptAt: NOTAM_NOW + 3600_000 };
  assert.equal(read().feed.nextAttemptAt, feed.nextAttemptAt); assert.equal(read().feed.state, 'degraded');
  feed = { ...feed, state: 'ready', error: null, checkedAt: NOTAM_NOW + 3600_000, watermark: NOTAM_NOW + 3600_000 };
  assert.equal(read().feed.checkedAt, feed.checkedAt); assert.equal(reads, 3);
});

test('airport delivery bounds both query cardinality and retained bytes including compressed encodings', async () => {
  const snapshot = notamSnapshot([]); let records = snapshot.records;
  const responder = createNotamResponder({ readRegion() { throw new Error('Unexpected regional query'); }, readNavaid() { throw new Error('Unexpected navaid query'); }, get status() { return snapshot.feed; }, readAirport(query) { return { ...snapshot, records, query }; } },
    async body => Buffer.from(body)); // Deliberately incompressible-sized output exercises the full retention budget.
  for (let i = 0; i < 300; i++) responder.read(`/api/notams/airports?faaId=${String(i).padStart(3, '0')}`, undefined);
  assert.ok(responder.stats.entries <= 128);
  records = Array.from({ length: 5 }, (_, i) => notice({ id: String(i).padStart(16, '0'), sourceId: String(i).padStart(16, '0'), text: 'x'.repeat(220_000), translations: [] }));
  for (let i = 1000; i < 1100; i++) {
    const payload = responder.read(`/api/notams/airports?faaId=${i}`, undefined); assert.equal(payload.status, 200);
    await responder.encoded(payload); assert.ok(responder.stats.bytes <= 32 * 1024 * 1024);
  }
  assert.ok(responder.stats.entries < 32, 'large snapshots must evict by bytes, not just entry count');
});

test('oversized multi-version evidence returns explicit unavailability and repeated reads reuse that decision', () => {
  const { revision: _revision, ...facts } = notice();
  const variants = Array.from({ length: 8 }, (_, i) => recordWithRevision({ ...facts, text: `Version ${i}`,
    translations: Array.from({ length: 7 }, (_, j) => ({ type: `OTHER:${j}`, text: '"\n'.repeat(125_000) })) }));
  const collection = collectNotamRecords({ records: [] }, variants);
  const snapshot = notamSnapshot([], { issues: [...collection.issues!], contentCoverage: 'incomplete' }); let reads = 0;
  snapshot.feed = { ...snapshot.feed, recordCount: 1, continuity: 'incomplete', collectionContinuity: 'complete', unresolvedRecords: 1, unscopedRecords: 0 };
  const responder = createNotamResponder({ readRegion() { throw new Error('Unexpected regional query'); }, readNavaid() { throw new Error('Unexpected navaid query'); }, get status() { return snapshot.feed; }, readAirport(query) { reads++; return { ...snapshot, query }; } });
  for (let i = 0; i < 100; i++) {
    const response = responder.read('/api/notams/airports?faaId=TST', undefined);
    assert.equal(response.status, 503); assert.deepEqual(JSON.parse(response.body.toString()), { error: 'airport-size-limit' });
  }
  assert.equal(reads, 1); assert.ok(responder.stats.bytes < 1024);
});

test('source issues round-trip exactly and malformed queries cannot read snapshots', () => {
  const { revision: _revision, ...facts } = notice();
  const collection = collectNotamRecords({ records: [recordWithRevision(facts)] }, [recordWithRevision({ ...facts, text: 'Different source version' })]);
  const snapshot = notamSnapshot([], { issues: [...collection.issues!], contentCoverage: 'incomplete' }); let reads = 0;
  const responder = createNotamResponder({ readRegion() { throw new Error('Unexpected regional query'); }, readNavaid() { throw new Error('Unexpected navaid query'); }, get status() { return snapshot.feed; }, readAirport(query) { reads++; return { ...snapshot, query }; } });
  const response = responder.read('/api/notams/airports?faaId=TST', undefined);
  assert.deepEqual(JSON.parse(response.body.toString()), { ...snapshot, query: { faaId: 'TST' } });
  for (const query of ['url=https://example.test', 'faaId=TST&faaId=TST', 'faaId=', 'icaoId=1234', 'faaId=TST&refresh=1']) {
    assert.equal(responder.read(`/api/notams/airports?${query}`, undefined).status, 400);
  }
  assert.equal(responder.read('/api/notams/airports?faaId=TST', 'bytes=0-1').status, 400); assert.equal(reads, 1);
});

test('real HTTP load and slow readers cannot trigger FAA calls or block local overload handling', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notam-http-load-')); let now = NOTAM_NOW, calls = 0;
  const records = Array.from({ length: 40 }, (_, i) => notice({ id: String(i).padStart(16, '0'), sourceId: String(i).padStart(16, '0'), text: 'x'.repeat(200_000), translations: [] }));
  const state = join(directory, 'nms'), store = new NotamStore(join(state, 'production'), 'production', () => now);
  await store.restore(); await store.reserve('bulk');
  await store.publish({ schemaVersion: 2, environment: 'production', records, checkedAt: now, watermark: now, fullSyncAt: now, baselineAt: now, complete: true });
  await store.close(); now += 180_000;
  const app = await createInfoServer({ directory, startUpdates: false, notams: { enabled: true, environment: 'production', credentials: { clientId: 'fixture', clientSecret: 'fixture' }, directory: state },
    now: () => now, notamWait: async ms => { now += ms; }, fetch: async input => {
      calls++; now += 1001;
      return new URL(String(input)).pathname === '/v1/auth/token'
        ? Response.json({ access_token: 'fixture', expires_in: 1799 })
        : Response.json({ status: 'Success', data: { aixm: [] } });
    } });
  const clients: ClientRequest[] = [], bodies: IncomingMessage[] = [];
  try {
    await app.notams.restore();
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address(); assert.ok(address && typeof address !== 'string'); const origin = `http://127.0.0.1:${address.port}`;
    const path = '/api/notams/airports?faaId=TST';
    const statuses = await Promise.all(Array.from({ length: 32 }, () => new Promise<number>((resolve, reject) => {
      const request = httpRequest(origin + path, { headers: { 'Accept-Encoding': 'identity' } }, response => {
        bodies.push(response); response.on('error', () => {}); response.pause(); resolve(response.statusCode!);
      });
      request.on('error', reject); request.setTimeout(10_000, () => request.destroy(new Error('fixture request timeout')));
      clients.push(request); request.end();
    })));
    assert.ok(statuses.includes(200)); assert.ok(statuses.includes(503), 'excess slow readers must be rejected locally');
    assert.equal((await fetch(origin + '/api/notams/healthz')).status, 200); assert.equal(calls, 0);
    for (const response of bodies) response.destroy(); for (const request of clients) request.destroy();
    // Socket-close notifications must drain before testing ordinary reads again.
    for (let retry = 0; retry < 100; retry++) {
      const response = await fetch(origin + path, { method: 'HEAD' });
      if (response.status === 200) break;
      assert.ok(retry < 99); await new Promise(resolve => setTimeout(resolve, 5));
    }
    const station = await fetch(origin + '/api/notams/navaids?navaidId=AUX');
    assert.equal(station.status, 200); assert.ok(isNotamNavaidSnapshot(await station.json()));
    const stationHead = await fetch(origin + '/api/notams/navaids?navaidId=AUX', { method: 'HEAD' });
    assert.equal(stationHead.status, 200); assert.equal(await stationHead.text(), '');
    await Promise.all(Array.from({ length: 200 }, async (_, i) => {
      const response = await fetch(origin + (i % 5 ? '/api/notams/airports?faaId=AUX' : '/api/notams/healthz'));
      assert.ok([200, 503].includes(response.status)); await response.arrayBuffer();
    }));
    assert.equal(calls, 0, 'including an uncached airport, reads cannot acquire source data');
    for (let i = 0; i < 1000; i++) app.notams.refresh();
    await app.notams.settled(); assert.equal(calls, 2, 'one scheduled round renews a token and makes one global delta call');
    for (let i = 0; i < 1000; i++) app.notams.refresh();
    await app.notams.settled(); assert.equal(calls, 2, 'excess scheduler ticks cannot spend the next data allowance');
    const head = await fetch(origin + path, { method: 'HEAD', headers: { 'Accept-Encoding': 'identity' } }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
    assert.ok(Number(head.headers.get('content-length')) > 1_000_000);
  } finally {
    for (const response of bodies) response.destroy(); for (const request of clients) request.destroy();
    await app.close(); await rm(directory, { recursive: true, force: true });
  }
});
