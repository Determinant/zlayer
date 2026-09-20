import assert from 'node:assert/strict';
import test from 'node:test';
import { TerrainWorkLimit } from '../src/layers/terrain/work-limit';

test('tile work stays bounded and canceled queued jobs never allocate', { timeout: 3000 }, async () => {
  const queue = new TerrainWorkLimit(4);
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
  const queue = new TerrainWorkLimit(1), signal = new AbortController().signal;
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
