import assert from 'node:assert/strict';
import test from 'node:test';
import { createTaskLimiter, TaskLimiter } from '../src/core/data/task-limiter';

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

test('tile work stays bounded and canceled queued jobs never allocate', { timeout: 3000 }, async () => {
  const queue = new TaskLimiter(4);
  let active = 0, peak = 0;
  const started: number[] = [], release: (() => void)[] = [];
  const controllers = Array.from({ length: 12 }, () => new AbortController());
  const jobs = controllers.map((controller, index) => queue.run(controller.signal, async () => {
    started.push(index); peak = Math.max(peak, ++active);
    await new Promise<void>(resolve => release.push(resolve));
    active--;
    return index;
  }));
  assert.deepEqual(started, [0, 1, 2, 3]);
  const canceled = assert.rejects(jobs[4]!, { name: 'AbortError' });
  controllers[4]!.abort();
  await canceled;
  for (const count of [4, 4, 3]) {
    const batch = started.slice(-count);
    release.splice(0).forEach(resolve => resolve());
    await Promise.all(batch.map(index => jobs[index]));
  }
  await Promise.all(jobs.filter((_, index) => index !== 4));
  assert.equal(active, 0);
  assert.equal(peak, 4);
  assert.equal(started.includes(4), false);
});

test('failure and cancellation after a slot is handed over cannot strand later tile jobs', async () => {
  const queue = new TaskLimiter(1), signal = new AbortController().signal;
  let fail!: (error: Error) => void;
  const first = queue.run(signal, () => new Promise<void>((_resolve, reject) => { fail = reject; }));
  const controller = new AbortController();
  let started = false;
  const next = queue.run(controller.signal, async () => { started = true; });
  const last = queue.run(signal, async () => 'finished');
  const failed = assert.rejects(first, /failed tile/);
  const canceled = assert.rejects(next, { name: 'AbortError' });
  fail(new Error('failed tile'));
  // The first job's finally hands over its slot before this queued microtask.
  queueMicrotask(() => controller.abort());
  await Promise.all([failed, canceled]);
  assert.equal(started, false);
  assert.equal(await last, 'finished');
});

test('draining admission keeps active cancellation attached to cleanup', async () => {
  const queue = new TaskLimiter(1), cleanup = gate(), controller = new AbortController();
  let finished = false;
  const first = queue.run(controller.signal, async () => {
    await cleanup.promise;
    controller.signal.throwIfAborted();
  }).finally(() => { finished = true; });
  const canceled = assert.rejects(first, { name: 'AbortError' });
  controller.abort();
  let next = false;
  const second = queue.run(signal(), async () => { next = true; });
  await turn();
  assert.equal(finished, false);
  assert.equal(next, false);
  cleanup.resolve();
  await Promise.all([canceled, second]);
  assert.equal(finished, true);
  assert.equal(next, true);
});
