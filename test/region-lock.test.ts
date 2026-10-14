import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { withRegionDownloadLock } from '../src/offline/region-lock';
import { createBrowserDownloads } from '../src/offline/browser-downloads';
import { deferred } from './helpers/deferred';

const lockName = 'zlayer-region-downloads';

async function holdLock(t: TestContext) {
  const entered = deferred(), release = deferred();
  const request = navigator.locks.request(lockName, async () => {
    entered.resolve();
    await release.promise;
  });
  t.after(async () => { release.resolve(); await request; });
  await entered.promise;
  return async () => { release.resolve(); await request; };
}

test('a download waits for brief storage contention and runs once after the lock is released', async t => {
  const release = await holdLock(t);
  const manager = createBrowserDownloads(async () => {});
  let calls = 0;
  const request = manager.backend.exclusive(async () => { calls++; });
  assert.equal((await navigator.locks.query()).pending?.filter(lock => lock.name === lockName).length, 1);
  assert.equal(calls, 0);
  await release();
  await request;
  assert.equal(calls, 1);
});

test('long contention expires after two seconds and cannot run later; a fresh retry succeeds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const release = await holdLock(t);
  let calls = 0;
  const request = withRegionDownloadLock(async () => { calls++; });
  const rejected = assert.rejects(request, /Offline storage is busy/);
  t.mock.timers.tick(1_999);
  assert.equal((await navigator.locks.query()).pending?.filter(lock => lock.name === lockName).length, 1);
  t.mock.timers.tick(1);
  await rejected;
  await release();
  assert.equal(calls, 0);
  await withRegionDownloadLock(async () => { calls++; });
  assert.equal(calls, 1);
});

test('the acquisition deadline cannot release an admitted mutation or replace its error', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const failure = new Error('Storage write failed');
  const request = withRegionDownloadLock(async () => {
    entered.resolve();
    await release.promise;
    throw failure;
  });
  const rejected = assert.rejects(request, error => error === failure);
  await entered.promise;
  t.mock.timers.tick(10_000);
  assert.equal((await navigator.locks.query()).held?.filter(lock => lock.name === lockName).length, 1);
  release.resolve();
  await rejected;
  assert.equal((await navigator.locks.query()).held?.filter(lock => lock.name === lockName).length, 0);
});

test('missing browser coordination refuses mutations', async t => {
  t.mock.getter(navigator, 'locks', () => undefined as unknown as LockManager);
  let called = false;
  await assert.rejects(withRegionDownloadLock(async () => { called = true; }), /safe multi-window download coordination/);
  assert.equal(called, false);
});
