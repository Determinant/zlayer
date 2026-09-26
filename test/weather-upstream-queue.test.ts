import assert from 'node:assert/strict';
import test from 'node:test';
import { UpstreamQueue } from '../tools/weather-server/upstream-queue';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const gate = () => {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), release: () => resolve() };
};
test('upstream FIFO respects start spacing and capacity, and removes aborted waiters', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const queue = new UpstreamQueue(2, 100), started: number[] = [], controls = Array.from({ length: 4 }, () => new AbortController());
  const gates = Array.from({ length: 4 }, gate);
  const tasks = gates.map((gate, index) => queue.run(controls[index]!.signal, async () => { started.push(index); await gate.promise; }));
  const aborted = assert.rejects(tasks[2]!, { name: 'AbortError' });
  await flush(); assert.deepEqual(started, [0]);
  t.mock.timers.tick(99); await flush(); assert.deepEqual(started, [0]);
  t.mock.timers.tick(1); await flush(); assert.deepEqual(started, [0, 1]);
  t.mock.timers.tick(1000); await flush(); assert.deepEqual(started, [0, 1], 'capacity waits need no polling timer');
  controls[2]!.abort(); await aborted;
  gates[0]!.release(); await flush(); assert.deepEqual(started, [0, 1, 3]);
  for (const gate of gates) gate.release();
  await Promise.allSettled(tasks);
});
test('upstream bounds queued work and rejects pending requests immediately on backoff', async () => {
  const queue = new UpstreamQueue(1, 0), hold = gate(), signal = new AbortController().signal;
  const active = queue.run(signal, () => hold.promise);
  const waiting = Array.from({ length: 31 }, () => queue.run(new AbortController().signal, async () => assert.fail('Backed-off work started')));
  const results = Promise.allSettled(waiting);
  await assert.rejects(queue.run(signal, async () => {}), /queue is full/);
  queue.backoff(Date.now() + 60_000);
  assert.ok((await results).every(result => result.status === 'rejected' && /backing off/.test(String(result.reason))));
  await assert.rejects(queue.run(signal, async () => {}), /backing off/);
  hold.release(); await active;
});
