import { deviceToBody, type Mount } from './estimator/device-frame';
import { RAD, conjugate, finiteVector, fromEuler, multiply, rotate } from './estimator/math';
import type { MagneticSample } from './estimator/types';
import { MotionClock } from './motion-clock';

export type MagneticCallbacks = { sample(value: MagneticSample): void; issue(message: string): void };
type FieldSensor = EventTarget & { x: number | null; y: number | null; z: number | null;
  timestamp: number | null; start(): void; stop(): void };
type FieldConstructor = new (options: { frequency: number; referenceFrame: 'device' }) => FieldSensor;
type CompassEvent = DeviceOrientationEvent & { webkitCompassHeading?: number; webkitCompassAccuracy?: number };

/** W3C intrinsic Z-X'-Y'' device→ENU rotation. Screen rotation never changes
 * hardware axes. Only absolute events supply a magnetic orientation reference;
 * their north convention cancels because the estimator uses changes only. */
export function orientationNorth(alpha: number, beta: number, gamma: number) {
  const q = multiply(multiply(fromEuler(0, 0, alpha * RAD), fromEuler(beta * RAD, 0, 0)), fromEuler(0, gamma * RAD, 0));
  return rotate(conjugate(q), [0, 1, 0]);
}

/** Optional sensor capability: permission/hardware failure never stops IMU/GPS.
 * Prefer calibrated field vectors; fall back to OS absolute orientation or the
 * Safari compass. Fused orientation is labelled separately, never raw magnetic data. */
export function createMagneticSensor(mount: Mount, callbacks: MagneticCallbacks) {
  let running = false, generation = 0, sensor: FieldSensor | undefined;
  let fieldClock = new MotionClock(), orientationClock = new MotionClock(), lastField = -Infinity;
  const report = (message: string) => { if (running) callbacks.issue(message); };
  const orientation = (event: DeviceOrientationEvent) => {
    if (!running || document.hidden) return;
    const received = performance.now();
    if (received / 1000 - lastField <= 1.5) return;
    const compass = event as CompassEvent;
    let sample: Omit<Extract<MagneticSample, { source: 'webkit-compass' }>, 'time'> |
      Omit<Extract<MagneticSample, { source: 'absolute-orientation' }>, 'time'>;
    if (typeof compass.webkitCompassHeading === 'number') {
      if (!Number.isFinite(compass.webkitCompassHeading) || typeof compass.webkitCompassAccuracy !== 'number' ||
        !Number.isFinite(compass.webkitCompassAccuracy) || compass.webkitCompassAccuracy < 0 || compass.webkitCompassAccuracy > 20) {
        report('Compass accuracy is unavailable or poor'); return;
      }
      sample = { source: 'webkit-compass', heading: compass.webkitCompassHeading,
        accuracy: compass.webkitCompassAccuracy, axis: deviceToBody([0, 1, 0], mount) };
    } else {
      if (!event.absolute || !finiteVector([event.alpha, event.beta, event.gamma])) return;
      sample = { source: 'absolute-orientation', vector: deviceToBody(orientationNorth(event.alpha!, event.beta!, event.gamma!), mount) };
    }
    try {
      const timing = orientationClock.read(event.timeStamp, received, performance.timeOrigin);
      if (!timing) return;
      if (timing.receivedTime - timing.time > .5) { report('Magnetic reading is stale'); return; }
      callbacks.sample({ ...sample, time: timing.time });
    } catch { report('Invalid magnetic reading timestamp'); }
  };
  const field = () => {
    if (!running || document.hidden || !sensor) return;
    const vector = [sensor.x, sensor.y, sensor.z];
    if (!finiteVector(vector) || sensor.timestamp === null) { report('Incomplete magnetic field reading'); return; }
    try {
      const timing = fieldClock.read(sensor.timestamp, performance.now(), performance.timeOrigin);
      if (!timing) return;
      if (timing.receivedTime - timing.time > .5) { report('Magnetic reading is stale'); return; }
      lastField = timing.time;
      callbacks.sample({ source: 'magnetometer', time: timing.time, vector: deviceToBody(vector, mount) });
    } catch { report('Invalid magnetic reading timestamp'); }
  };
  const stopField = () => {
    const previous = sensor;
    sensor = undefined; lastField = -Infinity;
    previous?.removeEventListener('reading', field); previous?.removeEventListener('error', fieldError);
    previous?.stop();
  };
  const fieldError = () => {
    stopField(); report('Magnetic field sensor unavailable; waiting for browser compass');
  };
  const visibility = () => { if (document.hidden) report('Magnetic readings paused'); };
  return {
    async start() {
      const session = ++generation;
      running = true; fieldClock = new MotionClock(); orientationClock = new MotionClock(); lastField = -Infinity;
      // Invoke the permission request synchronously in the existing start gesture.
      let permission: Promise<string>;
      try {
        const constructor = typeof DeviceOrientationEvent === 'undefined' ? undefined : DeviceOrientationEvent as
          typeof DeviceOrientationEvent & { requestPermission?: (absolute?: boolean) => Promise<string> };
        permission = constructor?.requestPermission ? constructor.requestPermission(true) : Promise.resolve('granted');
      } catch { permission = Promise.resolve('denied'); }
      const Field = (window as unknown as { Magnetometer?: FieldConstructor }).Magnetometer;
      if (Field) {
        try {
          sensor = new Field({ frequency: 10, referenceFrame: 'device' });
          sensor.addEventListener('reading', field); sensor.addEventListener('error', fieldError); sensor.start();
        } catch { fieldError(); }
      }
      const result = await permission.catch(() => 'denied');
      if (session !== generation) return;
      if (result === 'granted') {
        window.addEventListener('deviceorientationabsolute', orientation as EventListener);
        window.addEventListener('deviceorientation', orientation);
      } else report('Compass permission denied; IMU and GPS continue');
      document.addEventListener('visibilitychange', visibility);
      if (!Field && typeof DeviceOrientationEvent === 'undefined') report('Magnetic sensing is unavailable in this browser');
    },
    stop() {
      generation++; running = false;
      stopField();
      window.removeEventListener('deviceorientationabsolute', orientation as EventListener);
      window.removeEventListener('deviceorientation', orientation);
      document.removeEventListener('visibilitychange', visibility);
    },
  };
}
