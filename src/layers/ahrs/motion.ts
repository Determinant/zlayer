import { RAD, finiteVector, scale } from './estimator/math';
import { deviceToBody, type Mount, type RawMotionSample } from './estimator/device-frame';
import type { ImuSample } from './estimator/types';
import { MotionClock, type MotionTime } from './motion-clock';
import { createMagneticSensor, type MagneticCallbacks } from './magnetic-sensor';

export type MotionPort = { start(): Promise<void>; stop(): void };
export type MotionReading = RawMotionSample & MotionTime & { eventTimestamp: number; interval: number };
export type MotionFactory = (mount: Mount, sample: (value: ImuSample, raw?: MotionReading) => void,
  issue: (message: string) => void, magnetic?: MagneticCallbacks) => MotionPort;

/** Device motion and optional magnetic input. Location uses the shared GPS source. */
export const createMotionSensor: MotionFactory = (mount, onSample, onIssue, magnetic) => {
  let generation = 0, running = false, sign: 1 | -1 = 1;
  let clock = new MotionClock();
  const compass = magnetic ? createMagneticSensor(mount, magnetic) : undefined;
  const motion = (event: DeviceMotionEvent) => {
    if (!running || document.hidden) return;
    const r = event.rotationRate, a = event.accelerationIncludingGravity;
    // Motion rates are XYZ (unlike orientation Euler angles):
    // https://www.w3.org/TR/orientation-event/#devicemotion-event
    const rate = r && [r.alpha, r.beta, r.gamma];
    const force = a && [a.x, a.y, a.z];
    if (!finiteVector(rate) || !finiteVector(force)) {
      onIssue('Incomplete motion reading. Waiting for fresh readings.'); return;
    }
    let timing: MotionTime | null;
    try { timing = clock.read(event.timeStamp, performance.now(), performance.timeOrigin); }
    catch (error) { onIssue((error as Error).message); return; }
    if (!timing) return;
    const raw: MotionReading = { ...timing, rotationRate: scale(rate, RAD),
      acceleration: force, eventTimestamp: event.timeStamp, interval: event.interval };
    onSample({ time: raw.time, gyro: deviceToBody(raw.rotationRate, mount),
      specificForce: deviceToBody(scale(force, sign), mount) }, raw);
  };
  const visibility = () => {
    if (document.hidden) onIssue('Motion paused. Readings will resume when you return.');
  };
  return {
    async start() {
      const session = ++generation;
      if (!window.isSecureContext) throw new Error('Motion access requires HTTPS.');
      if (typeof DeviceMotionEvent === 'undefined')
        throw new Error('Motion sensors are unavailable on this device.');
      const request = (DeviceMotionEvent as typeof DeviceMotionEvent & {
        requestPermission?: () => Promise<string>;
      }).requestPermission;
      // Called directly from the confirmation button to retain iOS user activation.
      const motionPermission = request ? request.call(DeviceMotionEvent) : Promise.resolve('granted');
      // Both requests begin in the same user gesture. Compass failure is optional.
      void compass?.start().catch(() => magnetic?.issue('Magnetic sensing unavailable; IMU and GPS continue'));
      const permission = await motionPermission.catch(error => { compass?.stop(); throw error; });
      if (session !== generation) return;
      if (permission !== 'granted') { compass?.stop(); throw new Error('Allow Motion & Orientation in this site’s settings, then retry.'); }
      const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      sign = ios && /AppleWebKit/.test(navigator.userAgent) ? -1 : 1;
      clock = new MotionClock();
      running = true;
      window.addEventListener('devicemotion', motion);
      document.addEventListener('visibilitychange', visibility);
    },
    stop() {
      generation++;
      running = false;
      compass?.stop();
      window.removeEventListener('devicemotion', motion);
      document.removeEventListener('visibilitychange', visibility);
    },
  };
};
