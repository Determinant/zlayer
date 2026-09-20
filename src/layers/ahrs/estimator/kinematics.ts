import { propagateCovariance, type NavState } from './eskf.js';
import { G, add, integrate, norm, scale, sub } from './math.js';
import { identity, sandwich, skew, zeros } from './linalg.js';
import { ACCELERATION, TRANSIENT_ACCELERATION, MAGNETIC_FIELD, MAGNETIC_BIAS,
  MAGNETIC_FIELD_WALK, MAGNETIC_BIAS_WALK, N } from './state-layout.js';
import type { AhrsOptions, ImuSample } from './types.js';

const accelerationDrivingVariance = (s: NavState, c: Required<AhrsOptions>) =>
  c.accelerationWalk ** 2 + 8 * G ** 2 * c.accelerationTimeConstant * norm(s.accelerationRate) ** 2;

/** Gyro-driven kinematics. Accelerometers enter ONLY as observations.
 * a = persistent acceleration + a zero-mean Gauss–Markov transient.
 * The persistent component has a slow random walk, retaining ambiguity without
 * fixing its value forever; only the transient decays. GPS observes the integral.
 */
export function predictKinematics(s: NavState, sample: ImuSample, interval: number, c: Required<AhrsOptions>): void {
  if (interval <= 0) return;
  const rate = sub(sample.gyro, s.bg), tau = c.accelerationTimeConstant;
  const steps = Math.max(1, Math.ceil(interval / .02), Math.ceil(norm(rate) * interval / .05), Math.ceil(interval / (.02 * tau)));
  const dt = interval / steps, decay = Math.exp(-dt / tau), integral = -tau * Math.expm1(-dt / tau);
  // Stable integral of (dt-t) exp(-t/tau), including small dt/tau.
  const x = dt / tau;
  const positionIntegral = x < .01 ? dt * dt * (.5 - x / 6 + x * x / 24 - x ** 3 / 120) : tau * (dt - integral);
  for (let step = 0; step < steps; step++) {
    // Coherent rotation permits faster changes of world acceleration. A 0.5 s
    // rate average attenuates alternating vibration; it supplies no attitude or
    // acceleration observation. A 2 g rotating-force allowance gives jerk
    // j = 2 g |rate| and OU driving variance 2 tau j². Keep the quiet-flight
    // diffusion as well, since translation need not involve any rotation.
    const rateGain = -Math.expm1(-dt / .5);
    s.accelerationRate = add(s.accelerationRate, scale(sub(rate, s.accelerationRate), rateGain));
    const accelerationNoise = accelerationDrivingVariance(s, c);
    s.p = add(s.p, add(scale(s.v, dt), add(scale(s.acceleration, dt * dt / 2), scale(s.transientAcceleration, positionIntegral))));
    s.v = add(s.v, add(scale(s.acceleration, dt), scale(s.transientAcceleration, integral)));
    s.transientAcceleration = scale(s.transientAcceleration, decay);
    s.q = integrate(s.q, rate, dt);
    const F = zeros(N), W = skew(rate), noise = new Float64Array(N);
    for (let i = 0; i < 3; i++) {
      F[i * N + i + 3] = 1;
      F[(i + 3) * N + ACCELERATION + i] = 1;
      F[(i + 3) * N + TRANSIENT_ACCELERATION + i] = 1;
      F[(TRANSIENT_ACCELERATION + i) * N + TRANSIENT_ACCELERATION + i] = -1 / tau;
      F[(i + 6) * N + i + 12] = -1;
      for (let j = 0; j < 3; j++) F[(i + 6) * N + j + 6] = -W[i * 3 + j]!;
      noise[i + 6] = c.gyroNoise ** 2;
      noise[i + 9] = c.accelBiasWalk ** 2;
      noise[i + 12] = c.gyroBiasWalk ** 2;
      noise[i + ACCELERATION] = c.persistentAccelerationWalk ** 2;
      noise[i + TRANSIENT_ACCELERATION] = accelerationNoise;
      noise[i + MAGNETIC_FIELD] = MAGNETIC_FIELD_WALK ** 2;
      noise[i + MAGNETIC_BIAS] = MAGNETIC_BIAS_WALK ** 2;
    }
    propagateCovariance(s, F, noise, dt);
  }
}

/** Age retained parameters across missing data. No gyro/force is integrated:
 * the caller supplies a separate unknown-motion attitude prior and resets p/v.
 * Random walks retain their means and add Q dt; the transient ages exactly.
 */
export function ageUnobservedState(s: NavState, dt: number, c: Required<AhrsOptions>): void {
  if (dt <= 0) return;
  if (c.gravityAiding) {
    const decay = Math.exp(-dt / c.accelerationTimeConstant), transform = identity(N);
    s.transientAcceleration = scale(s.transientAcceleration, decay);
    for (let i = 0; i < 3; i++) transform[(TRANSIENT_ACCELERATION + i) * N + TRANSIENT_ACCELERATION + i] = decay;
    s.P = sandwich(transform, s.P, N, N);
    // Missing samples do not establish quiet flight. Retain the last maneuver
    // allowance over the gap, then qualify the rate again from fresh samples.
    const variance = accelerationDrivingVariance(s, c) * c.accelerationTimeConstant / 2 * -Math.expm1(-2 * dt / c.accelerationTimeConstant);
    s.accelerationRate = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      s.P[(TRANSIENT_ACCELERATION + i) * N + TRANSIENT_ACCELERATION + i]! += variance;
      s.P[(ACCELERATION + i) * N + ACCELERATION + i]! += c.persistentAccelerationWalk ** 2 * dt;
    }
  }
  for (const [offset, density] of [[9, c.accelBiasWalk], [12, c.gyroBiasWalk],
    [MAGNETIC_FIELD, MAGNETIC_FIELD_WALK], [MAGNETIC_BIAS, MAGNETIC_BIAS_WALK]] as const)
    for (let i = 0; i < 3; i++) s.P[(offset + i) * N + offset + i]! += density ** 2 * dt;
}
