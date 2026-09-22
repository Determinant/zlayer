import assert from 'node:assert/strict';
import test from 'node:test';
import { ArchiveReaderPool } from '../src/layers/charts/reader-pool';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('coalesces one file and evicts least recently used idle readers', async () => {
  const opened: string[] = [];
  const disposed: string[] = [];
  const pool = new ArchiveReaderPool(async (url: string) => {
    opened.push(url);
    return { url, dispose: () => { disposed.push(url); } };
  }, 2);
  await Promise.all(Array.from({ length: 20 }, () => pool.use('a', async reader => reader.url)));
  assert.deepEqual(opened, ['a']);
  await pool.use('b', async () => {});
  await pool.use('a', async () => {});
  await pool.use('c', async () => {});
  assert.deepEqual(disposed, ['b']);
  assert.deepEqual(opened, ['a', 'b', 'c']);
});

test('waits for active reads and completed disposal before opening another file', async () => {
  let alive = 0;
  let peak = 0;
  const reading = gate();
  const disposal = gate();
  const opened: string[] = [];
  const pool = new ArchiveReaderPool(async (url: string) => {
    opened.push(url);
    peak = Math.max(peak, ++alive);
    return { dispose: async () => { await disposal.promise; alive -= 1; } };
  }, 1);
  const first = pool.use('a', async () => reading.promise);
  await tick();
  const second = pool.use('b', async () => {});
  const third = pool.use('c', async () => {});
  await tick();
  assert.deepEqual(opened, ['a']);
  reading.resolve();
  await tick();
  assert.deepEqual(opened, ['a'], 'disposal is still pending');
  disposal.resolve();
  await Promise.all([first, second, third]);
  assert.deepEqual(opened, ['a', 'b', 'c']);
  assert.equal(peak, 1);
});

test('failed initialization releases its slot and can be retried', async () => {
  let fail = true;
  const pool = new ArchiveReaderPool(async (url: string) => {
    if (url === 'a' && fail) throw new Error('open failed');
    return { dispose() {} };
  }, 1);
  const first = pool.use('a', async () => {});
  const queued = pool.use('b', async () => {});
  await assert.rejects(first, /open failed/);
  await queued;
  fail = false;
  await pool.use('a', async () => {});
  await assert.rejects(pool.use('a', async () => { throw new Error('read failed'); }), /read failed/);
  await pool.use('b', async () => {});
});

test('skips obsolete queued files but keeps a file needed by another tile', async () => {
  const opened: string[] = [];
  const reading = gate();
  const pool = new ArchiveReaderPool(async (url: string) => {
    opened.push(url);
    return { dispose() {} };
  }, 1);
  const active = pool.use('active', async () => reading.promise);
  await tick();
  const obsolete = new AbortController();
  const skipped = assert.rejects(pool.use('obsolete', async () => {}, obsolete.signal), { name: 'AbortError' });
  const cancelledShared = assert.rejects(pool.use('shared', async () => {}, obsolete.signal), { name: 'AbortError' });
  const stillNeeded = pool.use('shared', async () => {});
  obsolete.abort();
  reading.resolve();
  await Promise.all([active, skipped, cancelledShared, stillNeeded]);
  assert.deepEqual(opened, ['active', 'shared']);
});

test('clear releases idle readers, cancels queued opens, and permits a fresh generation', async () => {
  const opened: string[] = [], disposed: string[] = [];
  const delayed = gate();
  const pool = new ArchiveReaderPool(async url => {
    opened.push(url);
    if (url === 'old') await delayed.promise; // Simulate an opener that completes after cancellation.
    return { dispose: () => { disposed.push(url); } };
  }, 1);
  const old = assert.rejects(pool.use('old', async () => assert.fail('stale action')), { name: 'AbortError' });
  await tick();
  const queued = assert.rejects(pool.use('queued', async () => assert.fail('queued action')), { name: 'AbortError' });
  pool.clear(); pool.clear();
  const fresh = pool.use('old', async () => {});
  delayed.resolve();
  await Promise.all([old, queued, fresh]);
  assert.deepEqual(opened, ['old', 'old']);
  assert.deepEqual(disposed, ['old']);
  pool.clear(); await tick();
  assert.deepEqual(disposed, ['old', 'old']);
  for (let i = 0; i < 30; i++) {
    await pool.use('repeat', async () => {});
    pool.clear(); await tick();
  }
  assert.equal(disposed.length, opened.length, 'repeated reloads leave no resident readers');
});

test('aborting the last queued consumer releases its waiter immediately', async () => {
  const reading = gate();
  const pool = new ArchiveReaderPool(async () => ({ dispose() {} }), 1);
  const active = pool.use('active', async () => reading.promise);
  await tick();
  const controller = new AbortController();
  const cancelled = assert.rejects(pool.use('queued', async () => assert.fail('aborted action'), controller.signal), { name: 'AbortError' });
  controller.abort();
  await cancelled;
  reading.resolve(); await active;
  pool.clear();
});
