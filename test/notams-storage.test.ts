import assert from 'node:assert/strict';
import test from 'node:test';
import { deferred } from './helpers/deferred';
import { isNotamAirportSnapshot, notamAirportKey, type NotamAirportQuery, type NotamAirportSnapshot } from '@zlayer/contracts';
import { createNotamsClient } from '../src/layers/notams/client';
import { airportSnapshots } from '../src/layers/notams/storage';
import { notice, notamSnapshot, NOTAM_NOW } from './fixtures/notams';

function setup(t: test.TestContext) {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); } };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage } });
  t.after(() => original ? Object.defineProperty(globalThis, 'window', original) : Reflect.deleteProperty(globalThis, 'window'));
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: NOTAM_NOW });
  const create = (load: (query: NotamAirportQuery) => Promise<NotamAirportSnapshot>) => {
    const client = createNotamsClient({ debounceMs: 0, load });
    t.after(client.stop); client.start(); return client;
  };
  const advance = async (ms = 0) => {
    t.mock.timers.tick(ms);
    await new Promise<void>(resolve => setImmediate(resolve));
  };
  return { values, storage, create, advance };
}

function checked(snapshot: NotamAirportSnapshot, time = Date.now()): NotamAirportSnapshot {
  return { ...snapshot, feed: { ...snapshot.feed, checkedAt: time, watermark: time } };
}

test('25 active airports save a bounded subset that survives a new client and refresh', async t => {
  const { create, advance, values } = setup(t);
  const client = create(async query => checked(notamSnapshot([], { query })));
  for (let i = 0; i < 25; i++) {
    client.retain({ faaId: String(i).padStart(3, '0') }, true);
    await advance(1);
  }
  assert.equal(Object.keys(client.state.getSnapshot().airports).length, 25, 'active readers remain usable');
  const saved: NotamAirportSnapshot[] = JSON.parse(values.get(airportSnapshots.key)!);
  assert.equal(saved.length, 24);
  assert.equal(saved[0]?.query.faaId, '024', 'the most recently retrieved airport has priority');
  assert.ok(saved.every(snapshot => snapshot.query.faaId !== '000'));
  assert.ok(saved.every(isNotamAirportSnapshot));
  assert.deepEqual(airportSnapshots.read(), saved);
  client.stop();
  await advance(1000);
  let requests = 0;
  const restored = create(async query => { requests++; return checked(notamSnapshot([notice()], { query })); });
  assert.equal(Object.keys(restored.state.getSnapshot().airports).length, 24);
  for (const snapshot of saved) {
    assert.deepEqual(restored.state.getSnapshot().airports[notamAirportKey(snapshot.query)]?.snapshot, snapshot);
  }
  const query = saved[0]!.query, key = notamAirportKey(query);
  const release = restored.retain(query, false);
  await advance(); assert.equal(requests, 0, 'offline restoration needs no network');
  release(); restored.retain(query, true); await advance();
  assert.equal(requests, 1);
  assert.equal(restored.state.getSnapshot().airports[key]?.snapshot?.feed.checkedAt, Date.now());
  restored.stop();
  const again = create(async () => assert.fail('restoration must not fetch'));
  assert.deepEqual(again.state.getSnapshot().airports[key]?.snapshot?.records, [notice()]);
});

test('restoration skips implausible source-check times without losing other saved airports', async t => {
  const { create, advance } = setup(t);
  const good = checked(notamSnapshot([], { query: { faaId: 'ANC' } }));
  const future = checked(notamSnapshot(), NOTAM_NOW + 30_001);
  const undated = notamSnapshot([], { query: { faaId: 'SFO' } }); undated.feed.checkedAt = null;
  airportSnapshots.write([good, future, undated]);
  const client = create(async query => checked(notamSnapshot([notice()], { query })));
  assert.deepEqual(Object.keys(client.state.getSnapshot().airports), [notamAirportKey(good.query)]);
  client.retain(future.query, true); await advance();
  const entry = client.state.getSnapshot().airports[notamAirportKey(future.query)];
  assert.equal(entry?.snapshot?.feed.checkedAt, NOTAM_NOW);
  assert.equal(entry?.error, undefined);
  client.stop();
  const restored = create(async () => assert.fail('restoration must not fetch'));
  assert.deepEqual(restored.state.getSnapshot().airports[notamAirportKey(future.query)]?.snapshot, entry?.snapshot);
});

test('clock rollback permits a valid replacement of restored data but still rejects genuine regressions', async t => {
  const { create, advance } = setup(t);
  t.mock.timers.setTime(NOTAM_NOW + 3_600_000);
  let response = checked(notamSnapshot());
  const first = create(async () => response);
  first.retain(response.query, true); await advance(); first.stop();
  const client = create(async () => response), key = notamAirportKey(response.query);
  assert.equal(client.state.getSnapshot().airports[key]?.snapshot?.feed.checkedAt, Date.now());
  const release = client.retain(response.query, true); await advance();
  t.mock.timers.setTime(NOTAM_NOW);
  response = checked(notamSnapshot([notice({ text: 'RWY 09L CLSD' })]));
  release(); client.retain(response.query, true); await advance();
  assert.deepEqual(client.state.getSnapshot().airports[key]?.snapshot, response);
  assert.equal(client.state.getSnapshot().airports[key]?.error, undefined);
  const valid = response;
  for (const invalid of [checked(valid, NOTAM_NOW - 1000), checked(valid, NOTAM_NOW + 30_001)]) {
    response = invalid; client.retry(); await advance();
    assert.deepEqual(client.state.getSnapshot().airports[key]?.snapshot, valid);
    assert.ok(client.state.getSnapshot().airports[key]?.error);
    assert.deepEqual(airportSnapshots.read(), [valid], 'rejected updates must not replace saved data');
  }
  client.stop();
  assert.deepEqual(create(async () => response).state.getSnapshot().airports[key]?.snapshot, valid);
});

test('the same small source-clock tolerance applies to restoration and live responses', async t => {
  const { create, advance } = setup(t);
  const snapshot = checked(notamSnapshot(), NOTAM_NOW + 30_000);
  airportSnapshots.write([snapshot]);
  const client = create(async () => snapshot), key = notamAirportKey(snapshot.query);
  assert.deepEqual(client.state.getSnapshot().airports[key]?.snapshot, snapshot);
  client.retain(snapshot.query, true); await advance();
  assert.equal(client.state.getSnapshot().airports[key]?.error, undefined);
  assert.deepEqual(airportSnapshots.read(), [snapshot]);
});

test('byte-limited saves skip oversized airports while retaining complete smaller snapshots', async t => {
  const { create, advance, values } = setup(t);
  const records = Array.from({ length: 5 }, (_, i) => {
    const id = String(i).padStart(16, '0');
    return notice({ id, sourceId: id, text: 'x'.repeat(220_000), translations: [] });
  });
  const client = create(async query => checked(notamSnapshot(query.faaId === 'BIG' ? records : records.slice(0, 2), { query })));
  for (const faaId of ['BIG', 'AAA', 'BBB', 'CCC']) client.retain({ faaId }, true);
  await advance();
  assert.equal(Object.keys(client.state.getSnapshot().airports).length, 4);
  const saved = airportSnapshots.read();
  assert.equal(saved.length, 2);
  assert.ok(saved.every(snapshot => snapshot.query.faaId !== 'BIG' && snapshot.records.length === 2));
  assert.ok(values.get(airportSnapshots.key)!.length * 2 <= 1_900_000);
  client.stop();
  const restored = create(async () => assert.fail('restoration must not fetch'));
  assert.deepEqual(Object.values(restored.state.getSnapshot().airports).map(entry => entry.snapshot), saved);
});

test('denied writes preserve usable live data and the prior saved snapshot across restart', async t => {
  const { create, advance, storage, values } = setup(t);
  let response = checked(notamSnapshot());
  const client = create(async () => response), key = notamAirportKey(response.query);
  client.retain(response.query, true); await advance();
  const saved = values.get(airportSnapshots.key)!;
  storage.setItem = () => { throw new Error('Storage denied'); };
  await advance(1000); response = checked(notamSnapshot([notice({ text: 'RWY 09L CLSD' })]));
  client.retry(); await advance();
  assert.deepEqual(client.state.getSnapshot().airports[key]?.snapshot, response);
  assert.equal(client.state.getSnapshot().airports[key]?.error, undefined);
  assert.equal(values.get(airportSnapshots.key), saved);
  client.stop();
  const restored = create(async () => { throw new Error('Offline'); });
  const prior = JSON.parse(saved)[0];
  assert.deepEqual(restored.state.getSnapshot().airports[key]?.snapshot, prior);
  restored.retain(prior.query, true); await advance();
  assert.deepEqual(restored.state.getSnapshot().airports[key]?.snapshot, prior);
  assert.ok(restored.state.getSnapshot().airports[key]?.error);
  assert.equal(values.get(airportSnapshots.key), saved);
});

test('separate windows merge airport saves inside the shared lock without delaying live results', async t => {
  const { create, advance, values } = setup(t);
  const entered = deferred(), release = deferred();
  const holding = navigator.locks.request(airportSnapshots.key, async () => { entered.resolve(); await release.promise; });
  t.after(async () => { release.resolve(); await holding; });
  await entered.promise;
  const a = create(async query => checked(notamSnapshot([], { query })));
  const b = create(async query => checked(notamSnapshot([], { query })));
  a.retain({ faaId: 'AAA' }, true); a.retain({ faaId: 'CCC' }, true);
  b.retain({ faaId: 'BBB' }, true); await advance();
  assert.ok(a.state.getSnapshot().airports[notamAirportKey({ faaId: 'AAA' })]?.snapshot);
  assert.ok(a.state.getSnapshot().airports[notamAirportKey({ faaId: 'CCC' })]?.snapshot,
    'a pending save cannot delay the next airport request');
  assert.ok(b.state.getSnapshot().airports[notamAirportKey({ faaId: 'BBB' })]?.snapshot);
  assert.equal(values.has(airportSnapshots.key), false, 'publication waits for cross-window ownership');
  release.resolve(); await holding; await advance();
  assert.deepEqual(airportSnapshots.read().map(s => s.query.faaId).sort(), ['AAA', 'BBB', 'CCC']);
  a.stop(); b.stop();
  const restored = create(async () => assert.fail('restoration must not fetch'));
  assert.equal(Object.keys(restored.state.getSnapshot().airports).length, 3);
});

test('an older window cannot replace another window\'s fresher airport when saving or refreshing', async t => {
  const { create, advance } = setup(t);
  const query = { faaId: 'AAA' }, old = checked(notamSnapshot([notice()], { query }));
  airportSnapshots.write([old]);
  const a = create(async query => checked(notamSnapshot([], { query })));
  const b = create(async query => query.faaId === 'AAA' ? old : checked(notamSnapshot([], { query })));
  await advance(1000);
  a.retain(query, true); await advance();
  const fresh = a.state.getSnapshot().airports[notamAirportKey(query)]!.snapshot!;
  b.retain({ faaId: 'BBB' }, true); await advance();
  assert.deepEqual(airportSnapshots.read().find(s => s.query.faaId === 'AAA'), fresh);
  b.retain(query, true); await advance();
  assert.deepEqual(airportSnapshots.read().find(s => s.query.faaId === 'AAA'), fresh,
    'an older response cannot resurrect notices removed by a newer empty snapshot');
});

test('stopping a NOTAM client cancels its queued save without losing its usable live response', async t => {
  const { create, advance, values } = setup(t);
  const entered = deferred(), release = deferred();
  const holding = navigator.locks.request(airportSnapshots.key, async () => { entered.resolve(); await release.promise; });
  t.after(async () => { release.resolve(); await holding; });
  await entered.promise;
  const client = create(async query => checked(notamSnapshot([], { query })));
  const query = { faaId: 'AAA' }, key = notamAirportKey(query);
  client.retain(query, true); await advance(); client.stop();
  release.resolve(); await holding; await advance();
  assert.ok(client.state.getSnapshot().airports[key]?.snapshot);
  assert.equal(values.has(airportSnapshots.key), false);
  client.start(); client.retry(); client.retain(query, true); await advance();
  assert.deepEqual(airportSnapshots.read().map(s => s.query), [query]);
});

test('airport saves keep namespaces, environment changes and equal-check feed status distinct', async t => {
  const { create, advance } = setup(t);
  const query = { faaId: 'AAA' };
  const alias = checked(notamSnapshot([], { query: { icaoId: 'KAAA' } }));
  const staging = checked(notamSnapshot([], { query }));
  airportSnapshots.write([staging, alias]);
  let response = checked(notamSnapshot([], { query }), NOTAM_NOW - 1000);
  response.feed.environment = 'production';
  const client = create(async () => response); client.retain(query, true); await advance();
  assert.equal(airportSnapshots.read().find(s => s.query.faaId === 'AAA')?.feed.environment, 'production');
  assert.deepEqual(airportSnapshots.read().find(s => s.query.icaoId === 'KAAA'), alias);
  response = { ...response, feed: { ...response.feed, state: 'degraded', error: 'source-backoff' } };
  client.retry(); await advance();
  assert.deepEqual(airportSnapshots.read().find(s => s.query.faaId === 'AAA')?.feed, response.feed,
    'equal source checks can carry a new failure or recovery status');
});
