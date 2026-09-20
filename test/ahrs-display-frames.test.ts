import assert from 'node:assert/strict';
import test from 'node:test';
import { startDisplayFrames } from '../src/layers/ahrs/display-frames';

function frameClock() {
  let next = 0;
  const pending = new Map<number, (milliseconds: number) => void>();
  return {
    pending,
    request(callback: (milliseconds: number) => void) { pending.set(++next, callback); return next; },
    cancel(id: number) { pending.delete(id); },
    tick(milliseconds: number) {
      const callbacks = [...pending.values()]; pending.clear();
      for (const callback of callbacks) callback(milliseconds);
    },
  };
}

test('display stays at 60 FPS on high-refresh screens and uses every frame on slower screens', () => {
  for (const hz of [30, 60, 90, 120, 144, 240]) {
    const clock = frameClock(), drawn: number[] = [];
    const stop = startDisplayFrames(time => drawn.push(time), clock);
    for (let i = 0; i < hz * 10; i++) clock.tick(Math.round(i * 1000 / hz * 1000) / 1000);
    assert.equal(drawn.length, Math.min(hz, 60) * 10, `${hz} Hz must not change the display rate`);
    for (let second = 0; second < 10; second++) {
      assert.ok(drawn.filter(time => time >= second * 1000 && time < (second + 1) * 1000).length <= 60);
    }
    stop();
    assert.equal(clock.pending.size, 0);
  }
});

test('missed display frames are skipped, and stopping cancels queued or already dispatched callbacks', () => {
  const clock = frameClock(), drawn: number[] = [];
  const stop = startDisplayFrames(time => drawn.push(time), clock);
  clock.tick(0); clock.tick(5000); clock.tick(5001);
  assert.deepEqual(drawn, [0, 5000], 'no catch-up rendering after a delay');
  const late = [...clock.pending.values()][0]!;
  stop();
  late(6000); clock.tick(7000);
  assert.deepEqual(drawn, [0, 5000]);
  assert.equal(clock.pending.size, 0, 'a cancelled callback cannot restart the loop');
  const resume = startDisplayFrames(time => drawn.push(time), clock);
  clock.tick(7001);
  assert.equal(drawn.at(-1), 7001, 'reopening starts a fresh cadence');
  resume();
});
