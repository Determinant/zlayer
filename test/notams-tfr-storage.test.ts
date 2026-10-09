import assert from 'node:assert/strict';
import test from 'node:test';
import { deferred } from './helpers/deferred';
import { TFR_REFRESH_MS, type TfrSnapshot } from '@zlayer/contracts';
import { createTfrClient } from '../src/layers/notams/tfr-client';
import { tfrSnapshot } from '../src/layers/notams/storage';

const START = Date.parse('2026-10-05T21:00Z');
const snapshot = (checkedAt: number, error?: string): TfrSnapshot => ({ schemaVersion: 1, source: 'FAA-TFR', checkedAt,
  notices: [], ...(error ? { error } : {}) });

function setup(t: test.TestContext) {
  const values = new Map<string, string>();
  let writes = 0;
  const events = new EventTarget();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    localStorage: { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { writes++; values.set(key, value); } },
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
  } });
  t.after(() => original ? Object.defineProperty(globalThis, 'window', original) : Reflect.deleteProperty(globalThis, 'window'));
  t.mock.timers.enable({ apis: ['setTimeout'], now: START });
  const clock = { now: START };
  const create = (load: () => Promise<TfrSnapshot>) => {
    const client = createTfrClient({ now: () => clock.now, debounceMs: 0, load });
    t.after(client.stop); return client;
  };
  const advance = async (ms = 0) => { t.mock.timers.tick(ms); await new Promise<void>(resolve => setImmediate(resolve)); };
  return { create, clock, values, advance, writes: () => writes };
}

test('TFR refresh recovers after clock rollback, persists the repair and still rejects ordinary regressions', async t => {
  const { create, clock, advance } = setup(t);
  clock.now += 3_600_000;
  let response = snapshot(clock.now);
  const client = create(async () => response); client.start(); await advance();
  assert.equal(tfrSnapshot.read()?.checkedAt, clock.now);
  clock.now = START; response = snapshot(clock.now);
  await advance(TFR_REFRESH_MS);
  assert.deepEqual(client.state.getSnapshot().snapshot, response);
  assert.equal(client.state.getSnapshot().error, undefined);
  assert.deepEqual(tfrSnapshot.read(), response);
  const repaired = response;
  response = snapshot(START - 1);
  await advance(TFR_REFRESH_MS);
  assert.ok(client.state.getSnapshot().error);
  assert.deepEqual(client.state.getSnapshot().snapshot, repaired);
  assert.deepEqual(tfrSnapshot.read(), repaired);
  client.stop();
  const restored = create(async () => repaired); restored.start();
  assert.deepEqual(restored.state.getSnapshot().snapshot, repaired);
});

test('TFR reactivation can restore a valid cross-window repair after clock rollback', async t => {
  const { create, clock, advance } = setup(t);
  clock.now += 3_600_000;
  const client = create(async () => snapshot(clock.now)); client.start(); await advance(); client.stop();
  clock.now = START;
  const repaired = snapshot(clock.now); tfrSnapshot.write(repaired);
  client.start();
  assert.deepEqual(client.state.getSnapshot().snapshot, repaired, 'future in-memory state cannot outrank the saved repair');
});

test('future retained TFR detail cannot prevent repair when its index check is still plausible', async t => {
  const { create, clock, advance } = setup(t);
  clock.now += 60_000;
  let response: TfrSnapshot = { ...snapshot(START + 1000), notices: [{ id: '6/0001', modifiedAt: START,
    title: 'Test restriction', type: 'SECURITY', facility: 'ZLA', state: 'CA', detailCheckedAt: clock.now,
    startsAt: START, endsAt: null, text: 'Test restriction', areas: [] }] };
  const client = create(async () => response); client.start(); await advance();
  assert.deepEqual(tfrSnapshot.read(), response);
  clock.now = START; response = snapshot(clock.now);
  await advance(TFR_REFRESH_MS);
  assert.deepEqual(client.state.getSnapshot().snapshot, response);
  assert.equal(client.state.getSnapshot().error, undefined);
  assert.deepEqual(tfrSnapshot.read(), response);
});

test('TFR restoration does not rewrite a current snapshot and older windows cannot regress saved checks', async t => {
  const { create, clock, advance, writes } = setup(t);
  const old = snapshot(START); tfrSnapshot.write(old);
  const a = create(async () => snapshot(clock.now)), b = create(async () => old);
  const savedWrites = writes(); a.start(); b.start();
  assert.equal(writes(), savedWrites, 'a codec without a version envelope must not migrate on every read');
  clock.now += 1000;
  await advance();
  assert.equal(tfrSnapshot.read()?.checkedAt, clock.now);
  a.stop(); b.stop();
});

test('a queued TFR save is cancelled on disable and equal-check source status can still update', async t => {
  const { create, clock, advance, values } = setup(t);
  const entered = deferred(), release = deferred();
  const holding = navigator.locks.request(tfrSnapshot.key, async () => { entered.resolve(); await release.promise; });
  t.after(async () => { release.resolve(); await holding; });
  await entered.promise;
  let response = snapshot(clock.now);
  const client = create(async () => response); client.start(); await advance();
  assert.deepEqual(client.state.getSnapshot().snapshot, response);
  assert.equal(values.has(tfrSnapshot.key), false);
  client.stop(); release.resolve(); await holding; await advance();
  assert.equal(values.has(tfrSnapshot.key), false);
  client.start(); await advance();
  response = snapshot(clock.now, 'refresh-failed');
  await advance(TFR_REFRESH_MS);
  assert.deepEqual(tfrSnapshot.read(), response);
  response = snapshot(clock.now);
  await advance(TFR_REFRESH_MS);
  assert.deepEqual(tfrSnapshot.read(), response);
});

test('same-index detail publications replace old evidence without letting older responses or tabs regress it', async t => {
  const { create, clock, advance } = setup(t);
  const original: TfrSnapshot = { ...snapshot(START), notices: [{ id: '6/0001', modifiedAt: START,
    title: 'Test', type: 'SECURITY', facility: 'ZLA', state: 'CA', detailCheckedAt: START,
    startsAt: START, endsAt: null, text: 'Original restriction', areas: [] }] };
  let response = original;
  const client = create(async () => response); client.start(); await advance();
  clock.now += 600_000;
  response = { ...original, notices: original.notices.map(n => ({ ...n, detailCheckedAt: clock.now, text: 'Updated restriction' })) };
  await advance(TFR_REFRESH_MS);
  const current = response;
  assert.deepEqual(client.state.getSnapshot().snapshot, current);
  assert.deepEqual(tfrSnapshot.read(), current);
  for (const stale of [original, { ...original, notices: original.notices.map(({ detailCheckedAt: _age, ...n }) => n) }]) {
    response = stale;
    await advance(TFR_REFRESH_MS);
    assert.deepEqual(client.state.getSnapshot().snapshot, current);
    assert.deepEqual(tfrSnapshot.read(), current);
    const oldTab = create(async () => stale); oldTab.start(); await advance(); oldTab.stop();
    assert.deepEqual(tfrSnapshot.read(), current);
  }
  response = { ...current, error: 'refresh-failed' }; await advance(TFR_REFRESH_MS);
  assert.deepEqual(tfrSnapshot.read(), response, 'equal detail evidence still accepts source-status changes');
});
