import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createFrameTask } from '../src/core/graphics/frame-task';

function frameClock(t: TestContext) {
  const callbacks = new Map<number, FrameRequestCallback>();
  let next = 0;
  for (const [name, value] of [
    ['requestAnimationFrame', (callback: FrameRequestCallback) => { callbacks.set(++next, callback); return next; }],
    ['cancelAnimationFrame', (id: number) => { callbacks.delete(id); }],
  ] as const) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  return {
    get pending() { return callbacks.size; },
    tick() {
      const ready = [...callbacks.values()]; callbacks.clear();
      for (const callback of ready) callback(0);
    },
  };
}

test('frame tasks combine input bursts, read the latest state, and become idle after drawing', t => {
  const clock = frameClock(t), drawn: number[] = [];
  let input = 1;
  const task = createFrameTask(() => drawn.push(input));
  assert.equal(clock.pending, 0);
  task.schedule(); input = 2; task.schedule(); input = 3; task.schedule();
  assert.equal(clock.pending, 1);
  clock.tick();
  assert.deepEqual(drawn, [3]);
  assert.equal(clock.pending, 0);
});

test('immediate updates replace queued drawing; cancellation permits reuse without replaying old work', t => {
  const clock = frameClock(t), drawn: number[] = [];
  let input = 1;
  const task = createFrameTask(() => drawn.push(input));
  task.schedule(); input = 2; task.flush();
  assert.deepEqual(drawn, [2]);
  assert.equal(clock.pending, 0);
  task.schedule(); task.cancel(); task.cancel(); clock.tick();
  assert.deepEqual(drawn, [2]);
  input = 3; task.schedule(); clock.tick();
  assert.deepEqual(drawn, [2, 3]);
});

test('drawing releases its frame before callbacks, including reentrant scheduling and errors', t => {
  const clock = frameClock(t);
  let draws = 0;
  const task = createFrameTask(() => {
    if (++draws === 1) { task.schedule(); throw new Error('render failed'); }
  });
  task.schedule();
  assert.throws(() => clock.tick(), /render failed/);
  assert.equal(clock.pending, 1);
  clock.tick();
  assert.equal(draws, 2);
  assert.equal(clock.pending, 0);
});
