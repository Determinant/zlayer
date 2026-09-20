import assert from 'node:assert/strict';
import test from 'node:test';
import { MotionClock } from '../src/layers/ahrs/motion-clock';
import { Ahrs } from '../src/layers/ahrs/estimator/ahrs';
import { G, RAD } from '../src/layers/ahrs/estimator/math';
import { createMotionSensor, type MotionPort, type MotionReading } from '../src/layers/ahrs/motion';
import type { ImuSample } from '../src/layers/ahrs/estimator/types';

for (const epoch of [false, true]) test(`motion timing preserves event cadence with ${epoch ? 'epoch' : 'relative'} timestamps`, () => {
  const clock = new MotionClock(), origin = 1_800_000_000_000;
  const times = [10, 20, 30].map(time => clock.read(time + (epoch ? origin : 0), 50, origin)!);
  assert.deepEqual(times.map(sample => sample.time), [.01, .02, .03]);
  assert.ok(times.every(sample => sample.receivedTime === .05));
  assert.equal(times[0]!.clock, epoch ? 'epoch-event' : 'event');
});

test('delayed callbacks keep their original cadence and can catch up without recalibration', () => {
  const clock = new MotionClock(), filter = new Ahrs();
  for (let i = 0; i <= 60; i++) {
    const timing = clock.read(i * 10, 600, 0)!;
    filter.update({ time: timing.time, gyro: [0, 0, 10 * RAD], specificForce: [0, 0, -G] });
    if (i === 1) assert.equal(filter.getState(.6).status, 'stale', 'queued data must not look current');
  }
  assert.equal(filter.getState(.6).status, 'tracking');
  assert.ok(Math.abs(filter.getState(.6).yaw - 6) < .001, 'integrate captured intervals, not receipt times');
});

test('duplicate event timestamps are skipped without moving the clock or inventing an interval', () => {
  const clock = new MotionClock();
  assert.equal(clock.read(20, 25, 0)!.time, .02);
  assert.equal(clock.read(20, 30, 0), null);
  assert.equal(clock.read(20, 600, 0), null);
  assert.equal(clock.read(40, 600, 0)!.time, .04);
});

test('unreliable timestamps never silently become receipt time or nominal intervals', () => {
  for (const timestamp of [NaN, Infinity, -1, 103, 1_800_000_000_100]) {
    assert.throws(() => new MotionClock().read(timestamp, 100, 1_700_000_000_000), /Skipped motion/);
  }
  const reversed = new MotionClock();
  reversed.read(20, 25, 0);
  assert.equal(reversed.read(19, 30, 0), null, 'out-of-order readings supply no new integration interval');
  assert.equal(reversed.read(30, 35, 0)!.time, .03);
  const clock = new MotionClock();
  clock.read(20, 25, 1_800_000_000_000);
  assert.equal(clock.read(1_800_000_000_030, 35, 1_800_000_000_000)!.time, .03,
    'epoch and relative timestamps normalize onto the same clock');
});

test('sample intervals and gaps survive event normalization', () => {
  const clock = new MotionClock();
  assert.deepEqual([10, 20, 40, 80, 400].map(time => clock.read(time, time + 5, 0)!.time), [.01, .02, .04, .08, .4]);
  const filter = new Ahrs();
  for (const time of [.01, .02, .04, .08, .4]) filter.update({ time, gyro: [0, 0, 0], specificForce: [0, 0, -G] });
  assert.equal(filter.getState(.4).status, 'interrupted', 'a real sampling gap must remain visible to the estimator');
});

test('callback jitter does not accumulate fictitious pitch', () => {
  const clock = new MotionClock(), filter = new Ahrs({ gpsAiding: false });
  const frequency = 2 * Math.PI * 2, amplitude = 20 * RAD;
  for (let i = 0; i <= 10 * 120; i++) {
    const t = i / 120, pitch = amplitude / frequency * Math.sin(frequency * t);
    const timing = clock.read(t * 1000, (t + .03 + .02 * Math.sin(frequency * t)) * 1000, 0)!;
    filter.update({ time: timing.time, gyro: [0, amplitude * Math.cos(frequency * t), 0],
      specificForce: [G * Math.sin(pitch), 0, -G * Math.cos(pitch)] });
  }
  assert.ok(Math.abs(filter.getState(10.03).pitch) < .01);
});

test('the browser adapter preserves queued event times and retains receipt metadata', async t => {
  let sensor: MotionPort | undefined;
  t.after(() => sensor?.stop());
  const browser = Object.assign(new EventTarget(), { isSecureContext: true });
  class MotionEvent extends Event {
    rotationRate = { alpha: 1, beta: 2, gamma: 3 };
    accelerationIncludingGravity = { x: 0, y: G, z: 0 };
    interval = 10;
    constructor(timestamp: number) {
      super('devicemotion');
      Object.defineProperty(this, 'timeStamp', { value: timestamp });
    }
  }
  for (const [key, value] of Object.entries({ window: browser,
    document: Object.assign(new EventTarget(), { hidden: false }), DeviceMotionEvent: MotionEvent })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
  t.mock.method(performance, 'now', () => 50);
  const samples: ImuSample[] = [], raw: MotionReading[] = [], issues: string[] = [];
  sensor = createMotionSensor('upright', (sample, reading) => { samples.push(sample); raw.push(reading!); }, issue => issues.push(issue));
  await sensor.start();
  for (const time of [10, 20, 30]) browser.dispatchEvent(new MotionEvent(time));
  assert.deepEqual(samples.map(sample => sample.time), [.01, .02, .03]);
  assert.deepEqual(samples[0]!.gyro, [-3 * RAD, RAD, -2 * RAD]);
  assert.ok(raw.every(value => value.receivedTime === .05 && value.clock === 'event' && value.interval === 10));
  assert.deepEqual(issues, []);
  browser.dispatchEvent(new MotionEvent(30));
  assert.equal(samples.length, 3);
  assert.deepEqual(issues, [], 'a duplicate event does not end the sensor session');
  browser.dispatchEvent(new MotionEvent(40));
  assert.equal(samples.length, 4, 'fresh events continue after a duplicate');
  browser.dispatchEvent(new MotionEvent(39));
  assert.equal(samples.length, 4);
  assert.deepEqual(issues, [], 'out-of-order data is skipped');
  browser.dispatchEvent(new MotionEvent(1000));
  assert.match(issues[0]!, /ahead of receipt/);
  browser.dispatchEvent(new MotionEvent(50));
  assert.equal(samples.length, 5, 'a timing issue does not detach the listener');
});
