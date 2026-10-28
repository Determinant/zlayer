import { deviceToBody, type Mount } from './estimator/device-frame';
import { finiteVector } from './estimator/math';
import type { MagneticSample } from './estimator/types';
import { MotionClock } from './motion-clock';

export type MagneticCallbacks = { sample(value: MagneticSample): void; issue(message: string): void };
type FieldSensor = EventTarget & { x: number | null; y: number | null; z: number | null;
  timestamp: number | null; start(): void; stop(): void };
type FieldConstructor = new (options: { frequency: number; referenceFrame: 'device' }) => FieldSensor;

/** Optional raw field input for PX4. OS-fused orientation is not an independent
 * magnetic measurement, so it is neither requested nor advertised as a fallback. */
export function createMagneticSensor(mount: Mount, callbacks: MagneticCallbacks) {
  let running = false, sensor: FieldSensor | undefined, clock = new MotionClock();
  const report = (message: string) => { if (running) callbacks.issue(message); };
  const field = () => {
    if (!running || document.hidden || !sensor) return;
    const vector = [sensor.x, sensor.y, sensor.z];
    if (!finiteVector(vector) || sensor.timestamp === null) { report('Incomplete magnetic field reading'); return; }
    try {
      const timing = clock.read(sensor.timestamp, performance.now(), performance.timeOrigin);
      if (!timing) return;
      if (timing.receivedTime - timing.time > .5) { report('Magnetic reading is stale'); return; }
      callbacks.sample({ source: 'magnetometer', time: timing.time, vector: deviceToBody(vector, mount) });
    } catch { report('Invalid magnetic reading timestamp'); }
  };
  const stopField = () => {
    const previous = sensor;
    sensor = undefined;
    previous?.removeEventListener('reading', field); previous?.removeEventListener('error', fieldError);
    previous?.stop();
  };
  const fieldError = () => {
    stopField(); report('Raw magnetic sensor unavailable; IMU and GPS continue');
  };
  const visibility = () => { if (document.hidden) report('Magnetic readings paused'); };
  return {
    async start() {
      stopField();
      running = true; clock = new MotionClock();
      const Field = (window as unknown as { Magnetometer?: FieldConstructor }).Magnetometer;
      if (Field) {
        try {
          sensor = new Field({ frequency: 10, referenceFrame: 'device' });
          sensor.addEventListener('reading', field); sensor.addEventListener('error', fieldError); sensor.start();
        } catch { fieldError(); }
      } else report('Raw magnetic sensor unavailable; IMU and GPS continue');
      document.addEventListener('visibilitychange', visibility);
    },
    stop() {
      running = false;
      stopField();
      document.removeEventListener('visibilitychange', visibility);
    },
  };
}
