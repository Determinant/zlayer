import assert from 'node:assert/strict';
import test from 'node:test';
import { OnDemandRefresh } from '../src/core/layers/on-demand-refresh';
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('a product deadline overrides one interval, then default and failure intervals resume', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const refresh = new OnDemandRefresh({ intervalMs: 60_000, retryIntervalMs: 10_000, debounceMs: 0,
    refresh: async () => {
      calls++;
      if (calls === 1) return 1000;
      if (calls === 3) throw new Error('Refresh failed');
      return undefined;
    }, onState() {}, onError() {},
  });
  t.after(() => refresh.destroy());
  const advance = async (ms: number) => { t.mock.timers.tick(ms); await flush(); };
  refresh.setDemand(['airport'], true); await advance(0);
  await advance(999); assert.equal(calls, 1);
  await advance(1); assert.equal(calls, 2);
  await advance(59_999); assert.equal(calls, 2);
  await advance(1); assert.equal(calls, 3);
  await advance(9999); assert.equal(calls, 3);
  await advance(1); assert.equal(calls, 4);
});

test('failures use the optional retry interval; success restores normal polling and disabling cancels retries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0, fail = true;
  const errors: unknown[] = [];
  const refresh = new OnDemandRefresh({ intervalMs: 300_000, retryIntervalMs: 30_000, debounceMs: 0,
    refresh: async () => { calls++; if (fail) throw new Error('Warming'); }, onState() {}, onError: error => errors.push(error),
  });
  t.after(() => refresh.destroy());
  refresh.setDemand(['forecast'], true); t.mock.timers.tick(0); await flush();
  assert.equal(calls, 1); assert.equal(errors.length, 1);
  t.mock.timers.tick(29_999); await flush(); assert.equal(calls, 1);
  fail = false; t.mock.timers.tick(1); await flush(); assert.equal(calls, 2);
  t.mock.timers.tick(299_999); await flush(); assert.equal(calls, 2);
  fail = true; t.mock.timers.tick(1); await flush(); assert.equal(calls, 3);
  refresh.setDemand([], false); t.mock.timers.tick(300_000); await flush();
  assert.equal(calls, 3); assert.equal(errors.length, 2);
});

test('debounces scope changes, refreshes a stationary scope, and stops when disabled', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls: string[][] = [];
  const refresh = new OnDemandRefresh({ intervalMs: 60_000,
    refresh: async ids => { calls.push([...ids]); }, onState() {}, onError: error => { throw error; },
  });
  t.after(() => refresh.destroy());
  refresh.setDemand(['KSFO'], true);
  t.mock.timers.tick(200);
  refresh.setDemand(['KOAK', 'KSFO', 'KSFO'], true);
  t.mock.timers.tick(249);
  assert.equal(calls.length, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(calls, [['KOAK', 'KSFO']]);
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(calls.length, 2);
  refresh.setDemand(['KSFO'], false);
  t.mock.timers.tick(120_000);
  assert.equal(calls.length, 2);
});

test('aborts old work, waits for its cleanup, and never overlaps refreshes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls: string[][] = [];
  const signals: AbortSignal[] = [];
  const release: Array<() => void> = [];
  const refresh = new OnDemandRefresh({ intervalMs: 60_000,
    refresh: (ids, signal) => {
      calls.push([...ids]); signals.push(signal);
      return new Promise<void>(resolve => release.push(resolve));
    }, onState() {}, onError: error => { throw error; },
  });
  refresh.setDemand(['KSFO'], true);
  t.mock.timers.tick(250);
  refresh.setDemand(['KJFK'], true);
  assert.equal(signals[0]!.aborted, true);
  t.mock.timers.tick(10_000);
  assert.equal(calls.length, 1, 'cancelled work still owns its slot until settled');
  release[0]!(); await flush();
  t.mock.timers.tick(250);
  assert.deepEqual(calls, [['KSFO'], ['KJFK']]);
  refresh.destroy();
  assert.equal(signals[1]!.aborted, true);
  release[1]!(); await flush();
  t.mock.timers.tick(120_000);
  assert.equal(calls.length, 2);
});
