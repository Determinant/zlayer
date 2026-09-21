/** Focused counterexamples for docs/ahrs-validation.md.
 * Run: node --import=tsx tools/ahrs-review-probes.ts
 * Prints measurements, not an operational-accuracy specification.
 * No browser, network, recording, or persistent storage is used.
 */
import { createAhrsLayer } from '../src/layers/ahrs/layer';
import { Ahrs } from '../src/layers/ahrs/estimator/ahrs';
import { MotionClock } from '../src/layers/ahrs/motion-clock';
import type { GpsFix, ImuSample } from '../src/layers/ahrs/estimator/types';

const gravity = 9.80665, radians = Math.PI / 180;
const report = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

// Exercise the real layer's visible/stowed selection with the same 120 Hz stream.
for (const visible of [true, false]) {
  let now = 0, sample: (value: ImuSample) => void = () => {};
  const layer = createAhrsLayer({
    getSnapshot: () => ({ state: 'acquiring', fix: null }), subscribe: () => () => {},
    acquire: () => () => {}, retry: () => {},
  }, {
    now: () => now, timeOrigin: 0,
    motion: (_mount, callback) => { sample = callback; return { start: async () => {}, stop: () => {} }; },
  });
  try {
    await layer.calibrate('upright', 0);
    for (let i = 1; i <= 12 * 120; i++) {
      now = i / 120;
      sample({ time: now, gyro: [0, 0, 0], specificForce: [0, 0, -gravity] });
    }
    if (layer.readDisplaySnapshot().phase !== 'ready') throw new Error('Probe calibration did not complete');
    layer.setVisible(visible);
    for (let i = 1; i <= 4 * 120; i++) {
      const time = i / 120, frequency = 2 * Math.PI * 30;
      const rate = 10 * radians * Math.cos(frequency * time);
      const pitch = 10 * radians / frequency * Math.sin(frequency * time);
      now = 12 + time;
      sample({ time: now, gyro: [0, rate, 0],
        specificForce: [gravity * Math.sin(pitch), 0, -gravity * Math.cos(pitch)] });
    }
    const state = layer.readDisplaySnapshot().attitude!;
    report({ probe: 'stowed-decimation', visible, truthPitch: 0,
      pitch: state.pitch, tiltStd: state.tiltStd, status: state.status, rate: state.rate });
  } finally { layer.stop(); }
}

// Compare receipt timing with event timing under a deterministic 10–50 ms
// callback delay. Event creation time is the browser's best available proxy.
for (const timing of ['acquisition', 'receipt', 'adapter'] as const) {
  const filter = new Ahrs({ gpsAiding: false });
  const clock = new MotionClock();
  filter.setGyroBias([0, 0, 0], .05 * radians);
  const amplitude = 20 * radians, frequency = 2 * Math.PI * 2;
  for (let i = 0; i <= 10 * 120; i++) {
    const time = i / 120, pitch = amplitude / frequency * Math.sin(frequency * time);
    const delay = .03 + .02 * Math.sin(frequency * time);
    const normalized = clock.read(time * 1000, (time + delay) * 1000, 0)!.time;
    filter.update({ time: timing === 'receipt' ? time + delay : timing === 'adapter' ? normalized : time,
      gyro: [0, amplitude * Math.cos(frequency * time), 0],
      specificForce: [gravity * Math.sin(pitch), 0, -gravity * Math.cos(pitch)] });
  }
  const state = filter.getState(10.03);
  report({ probe: 'receipt-time-jitter', timing, truthPitch: 0,
    pitch: state.pitch, tiltStd: state.tiltStd, status: state.status });
}

// Independent analytic finite 90° coordinated turn, starting after three seconds.
function quarterTurn(time: number) {
  const speed = 50, rate = gravity * Math.tan(25 * radians) / speed, ramp = 8;
  const plateau = Math.PI / 2 / rate - ramp, t = Math.max(0, time - 3);
  const up = Math.min(t, ramp), hold = Math.max(0, Math.min(t - ramp, plateau));
  const down = Math.max(0, Math.min(t - ramp - plateau, ramp));
  const yaw = 120 * radians + rate * (up / 2 - ramp * Math.sin(Math.PI * up / ramp) / (2 * Math.PI) + hold +
    down / 2 + ramp * Math.sin(Math.PI * down / ramp) / (2 * Math.PI));
  const yawRate = t < ramp ? rate * (1 - Math.cos(Math.PI * t / ramp)) / 2
    : t < ramp + plateau ? rate : rate * (1 + Math.cos(Math.PI * down / ramp)) / 2;
  const yawAcceleration = t < ramp ? rate * Math.PI * Math.sin(Math.PI * t / ramp) / (2 * ramp)
    : t < ramp + plateau ? 0 : -rate * Math.PI * Math.sin(Math.PI * down / ramp) / (2 * ramp);
  const roll = Math.atan(speed * yawRate / gravity);
  const rollRate = speed / gravity * yawAcceleration / (1 + (speed * yawRate / gravity) ** 2);
  const cr = Math.cos(roll), sr = Math.sin(roll), north = speed * Math.cos(yaw) + 12, east = speed * Math.sin(yaw) - 9;
  return { yaw, roll,
    sample: { time, gyro: [rollRate, yawRate * sr, yawRate * cr],
      specificForce: [0, cr * speed * yawRate - sr * gravity, -sr * speed * yawRate - cr * gravity] } satisfies ImuSample,
    fix: { time, speed: Math.hypot(north, east), track: Math.atan2(east, north) / radians,
      accuracy: 3, altitude: null, altitudeAccuracy: null } satisfies GpsFix,
  };
}

// Generic estimator API: a deliberately wrong, overconfident heading prior.
// The current app passes null altitude to this API, so scope this finding accordingly.
for (const altitude of [false, true]) {
  const filter = new Ahrs({ gpsVelocityStd: .1, initialHeadingStd: 10 });
  filter.setGyroBias([0, 0, 0], .05 * radians);
  filter.update(quarterTurn(0).sample);
  filter.alignHeading(210); // Truth is 120°.
  let recovered: number | null = null;
  for (let i = 1; i <= 60 * 50; i++) {
    const time = i / 50, truth = quarterTurn(time);
    filter.update(truth.sample);
    if (i % 50 === 0) filter.updateGps({ ...truth.fix,
      altitude: altitude ? 1000 : null, altitudeAccuracy: altitude ? 5 : null });
    if (filter.getState(time).headingReference === 'gps-inertial') recovered ??= time;
  }
  const state = filter.getState(60), truth = quarterTurn(60), yawError = state.yaw * radians - truth.yaw;
  report({ probe: 'recovery-altitude-coupling', altitude, recovered,
    yawError: Math.atan2(Math.sin(yawError), Math.cos(yawError)) / radians,
    rollError: state.roll - truth.roll / radians, pitchError: state.pitch,
    headingStd: state.attitudeStd[2], fusion: state.fusion });
}
