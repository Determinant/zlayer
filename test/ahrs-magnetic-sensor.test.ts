import assert from 'node:assert/strict';
import test from 'node:test';
import { createMagneticSensor } from '../src/layers/ahrs/magnetic-sensor';
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

for (const mount of ['flat', 'upright'] as const) test(`${mount}: OS compass events are not a raw field fallback`, async t => {
  const s = browser(t, mount); await s.sensor.start();
  s.emit({ alpha: 0, beta: 90, gamma: 0, absolute: true }, 'deviceorientationabsolute');
  s.emit({ webkitCompassHeading: 120, webkitCompassAccuracy: 4 });
  assert.deepEqual(s.samples, []);
  assert.match(s.issues.at(-1)!, /Raw magnetic sensor unavailable/);
});

test('raw field timestamps, failure and cleanup', async t => {
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
  // A failed raw sensor must not activate the rejected OS compass input.
  field.dispatchEvent(new Event('error'));
  s.emit({ absolute: true, alpha: 0, beta: 0, gamma: 0 });
  assert.equal(s.samples.length, 1);
  assert.match(s.issues.at(-1)!, /Raw magnetic sensor unavailable/);
  s.advance(200); field.timestamp = 400; field.dispatchEvent(new Event('reading'));
  assert.equal(s.samples.length, 1, 'a failed sensor cannot keep emitting after its listeners are removed');
  s.document.hidden = true; s.document.dispatchEvent(new Event('visibilitychange'));
  assert.match(s.issues.at(-1)!, /paused/);
  s.advance(200); s.emit({ absolute: true, alpha: 0, beta: 0, gamma: 0 }); assert.equal(s.samples.length, 1);
  s.sensor.stop(); field.timestamp = 2000; field.dispatchEvent(new Event('reading'));
  assert.equal(s.samples.length, 1); assert.ok(field.stopped >= 1);
});

test('motion starts without requesting OS compass permission', async t => {
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
  assert.deepEqual(calls, ['motion']);
  await start;
  assert.ok(s.issues.some(message => /Raw magnetic sensor unavailable/.test(message)));
});
