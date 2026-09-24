import assert from 'node:assert/strict';
import test from 'node:test';
import { createTaskLimiter } from '../src/core/data/task-limiter';

const signal = () => new AbortController().signal;
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('task admission bounds working sets and cancelled queued tasks never start', async () => {
  const run = createTaskLimiter(1), started = gate(), release = gate(), cancel = new AbortController();
  const first = run(signal(), async () => { started.resolve(); await release.promise; return 'first'; });
  await started.promise;
  const skipped = assert.rejects(run(cancel.signal, async () => assert.fail('cancelled queued task ran')), /abort/i);
  cancel.abort(); await skipped;
  let next = false;
  const second = run(signal(), async () => { next = true; return 'second'; });
  await turn(); assert.equal(next, false);
  release.resolve(); assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
});

test('active cancellation waits for actual cleanup before admitting another working set; failures release the slot', async () => {
  const run = createTaskLimiter(1), started = gate(), release = gate(), cancel = new AbortController();
  const first = assert.rejects(run(cancel.signal, async () => { started.resolve(); await release.promise; }), /abort/i);
  await started.promise; cancel.abort(); await first;
  let next = false;
  const second = assert.rejects(run(signal(), async () => { next = true; throw new Error('Decoder failed'); }), /Decoder failed/);
  await turn(); assert.equal(next, false);
  release.resolve(); await second;
  assert.equal(await run(signal(), async () => 'recovered'), 'recovered');
  assert.throws(() => createTaskLimiter(0), /concurrency/);
});
