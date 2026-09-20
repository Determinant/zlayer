import assert from 'node:assert/strict';
import test from 'node:test';
import { createMagneticSensor, orientationNorth } from '../src/layers/ahrs/magnetic-sensor';
import { createMotionSensor } from '../src/layers/ahrs/motion';
import type { MagneticSample } from '../src/layers/ahrs/estimator/types';
import type { Mount } from '../src/layers/ahrs/estimator/device-frame';

function browser(t: test.TestContext, mount: Mount = 'flat') {
  let sensor: ReturnType<typeof createMagneticSensor> | undefined;
  const cleanup: (() => void)[] = [];
  t.after(() => { cleanup.forEach(stop => stop()); sensor?.stop(); });
  const window = Object.assign(new EventTarget(), { isSecureContext: true });
  const document = Object.assign(new EventTarget(), { hidden: false });
  class Orientation extends Event {
    constructor(values: Record<string, unknown>, type = 'deviceorientation') {
      super(type); Object.assign(this, values);
      Object.defineProperty(this, 'timeStamp', { value: values.time ?? now });
    }
    static requestPermission = async (_absolute?: boolean) => 'granted';
  }
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  const setGlobal = (key: string, value: unknown) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  };
  setGlobal('window', window); setGlobal('document', document); setGlobal('DeviceOrientationEvent', Orientation);
  const samples: MagneticSample[] = [], issues: string[] = [];
  sensor = createMagneticSensor(mount, { sample: value => samples.push(value), issue: reason => issues.push(reason) });
  return { window, document, Orientation, sensor, samples, issues, setGlobal,
    stopWith(stop: () => void) { cleanup.push(stop); }, advance(ms: number) { now += ms; },
    emit(values: Record<string, unknown>, type?: string) { window.dispatchEvent(new Orientation(values, type)); },
  };
}

test('absolute orientation reconstructs hardware-frame north through upright and flat poses', () => {
  const close = (actual: readonly number[], expected: readonly number[]) =>
    actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]!) < 1e-10));
  close(orientationNorth(0, 0, 0), [0, 1, 0]);
  close(orientationNorth(90, 0, 0), [1, 0, 0]);
  close(orientationNorth(0, 90, 0), [0, 0, -1]);
  close(orientationNorth(90, 90, 0), [1, 0, 0]);
});

for (const mount of ['flat', 'upright'] as const) test(`${mount}: browser compass is optional and relative orientation is never a magnetic reference`, async t => {
  const s = browser(t, mount); await s.sensor.start();
  s.emit({ alpha: 0, beta: 90, gamma: 0, absolute: false });
  assert.equal(s.samples.length, 0);
  s.emit({ alpha: 0, beta: 90, gamma: 0, absolute: true }, 'deviceorientationabsolute');
  assert.equal(s.samples.length, 1);
  const sample = s.samples[0]!;
  assert.equal(sample.source, 'absolute-orientation');
  if (sample.source !== 'absolute-orientation') throw new Error('Wrong source');
  assert.ok(Math.abs(sample.vector[mount === 'upright' ? 0 : 2] - 1) < 1e-10);
  s.advance(200);
  s.emit({ webkitCompassHeading: 120, webkitCompassAccuracy: 4 });
  assert.deepEqual(s.samples[1], { time: .3, source: 'webkit-compass', heading: 120, accuracy: 4,
    axis: mount === 'flat' ? [1, 0, -0] : [-0, 0, -1] });
  s.advance(200); s.emit({ webkitCompassHeading: 120, webkitCompassAccuracy: -1 });
  assert.equal(s.samples.length, 2); assert.match(s.issues.at(-1)!, /accuracy/);
  s.sensor.stop(); s.advance(200); s.emit({ webkitCompassHeading: 120, webkitCompassAccuracy: 4 });
  assert.equal(s.samples.length, 2);
});

test('field sensor precedence, timestamps, fallback and cleanup', async t => {
  const s = browser(t);
  let field!: Field;
  class Field extends EventTarget {
    x = 10; y = 25; z = -35; timestamp = 100; stopped = 0;
    constructor(options: unknown) { super(); assert.deepEqual(options, { frequency: 10, referenceFrame: 'device' }); field = this; }
    start() {} stop() { this.stopped++; }
  }
  Object.assign(s.window, { Magnetometer: Field });
  await s.sensor.start();
  field.dispatchEvent(new Event('reading'));
  assert.deepEqual(s.samples[0], { time: .1, source: 'magnetometer', vector: [25, 10, 35] });
  field.dispatchEvent(new Event('reading')); assert.equal(s.samples.length, 1);
  s.advance(100); s.emit({ absolute: true, alpha: 0, beta: 0, gamma: 0 });
  assert.equal(s.samples.length, 1, 'do not fuse two APIs for the same physical magnetic sensor');
  // Failure must release precedence immediately, even after a recent raw read.
  field.dispatchEvent(new Event('error'));
  s.emit({ absolute: true, alpha: 0, beta: 0, gamma: 0 });
  assert.equal(s.samples.at(-1)!.source, 'absolute-orientation');
  s.advance(200); field.timestamp = 400; field.dispatchEvent(new Event('reading'));
  assert.equal(s.samples.length, 2, 'a failed sensor cannot keep emitting into the fallback session');
  s.document.hidden = true; s.document.dispatchEvent(new Event('visibilitychange'));
  assert.match(s.issues.at(-1)!, /paused/);
  s.advance(200); s.emit({ absolute: true, alpha: 0, beta: 0, gamma: 0 }); assert.equal(s.samples.length, 2);
  s.sensor.stop(); field.timestamp = 2000; field.dispatchEvent(new Event('reading'));
  assert.equal(s.samples.length, 2); assert.ok(field.stopped >= 1);
});

test('permission requests start together and compass denial leaves motion usable', async t => {
  const s = browser(t), calls: string[] = [];
  class Motion extends Event {
    static requestPermission() { calls.push('motion'); return Promise.resolve('granted'); }
  }
  s.setGlobal('DeviceMotionEvent', Motion);
  s.Orientation.requestPermission = async absolute => { calls.push(`orientation:${absolute}`); return 'denied'; };
  const motion = createMotionSensor('flat', () => {}, () => { throw new Error('Compass must not report a motion failure'); },
    { sample: value => s.samples.push(value), issue: reason => s.issues.push(reason) });
  s.stopWith(motion.stop);
  const start = motion.start();
  assert.deepEqual(calls, ['motion', 'orientation:true']);
  await start;
  assert.ok(s.issues.some(message => /denied/.test(message)));
});

test('stopping while permission is pending prevents late listeners and stale samples', async t => {
  const s = browser(t);
  let finish!: (value: string) => void;
  s.Orientation.requestPermission = () => new Promise(resolve => { finish = resolve; });
  const start = s.sensor.start(); s.sensor.stop(); finish('granted'); await start;
  s.emit({ absolute: true, alpha: 0, beta: 0, gamma: 0 });
  assert.deepEqual(s.samples, []);
});
