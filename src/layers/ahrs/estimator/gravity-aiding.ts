import { correct, tiltStd, type NavState, type ObservationSink } from './eskf.js';
import { correctIterated } from './nonlinear-correction.js';
import { G, add, conjugate, multiply, norm, rotate, rotationBetween, rotationMatrix, sub, type Vec3 } from './math.js';
import { skew, transpose, zeros } from './linalg.js';
import { ACCELERATION, TRANSIENT_ACCELERATION, N } from './state-layout.js';
import type { AhrsOptions } from './types.js';

export type GravityObservation = { time: number; force: Vec3; variance: number; gyro?: Vec3;
  steadyForce?: Vec3; steadyGyro?: Vec3 };

/** f_body = Rᵀ(a_world - g_world) + b_accel.
 * Acceleration is a correlated nuisance state, not a zero-acceleration fact or
 * a fresh noise allowance that repeated observations can average away.
 */
export function gravityModel(s: NavState) {
  const force = rotate(conjugate(s.q), sub(add(s.acceleration, s.transientAcceleration), [0, 0, G]));
  const D = skew(force), Rt = transpose(rotationMatrix(s.q), 3, 3), H = zeros(3, N);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    H[i * N + 6 + j] = D[i * 3 + j]!;
    H[i * N + 9 + j] = i === j ? 1 : 0;
    H[i * N + ACCELERATION + j] = Rt[i * 3 + j]!;
    H[i * N + TRANSIENT_ACCELERATION + j] = Rt[i * 3 + j]!;
  }
  return { expected: add(force, s.ba), H };
}

export function fuseGravity(s: NavState, observation: GravityObservation, config: Required<AhrsOptions>, publish?: ObservationSink): void {
  const consecutive = observation.time - s.tilt.lastAttempt <= config.maxGap + 1e-9;
  s.tilt.lastAttempt = observation.time;
  const load = norm(sub(observation.force, s.ba)) / G;
  const steadyLoad = norm(sub(observation.steadyForce ?? observation.force, s.ba)) / G;
  const steadyGyro = observation.steadyGyro ?? observation.gyro;
  const quiet = steadyLoad > .85 && steadyLoad < 1.15 && steadyGyro !== undefined && norm(sub(steadyGyro, s.bg)) < .05;
  s.tilt.quietSince = quiet ? (consecutive ? Math.min(s.tilt.quietSince, observation.time) : observation.time) : Infinity;
  if (load < .1) {
    s.tilt.rejected++;
    s.tilt.nis = null;
    s.tilt.reason = 'Accelerometer load outside gravity-aiding range';
    publish?.({ source: 'tilt', time: observation.time, dimension: 0, residual: [], covariance: null,
      nis: null, gate: null, result: 'geometry' });
    return;
  }
  const model = (state: NavState) => {
    const { expected, H } = gravityModel(state);
    return { residual: sub(observation.force, expected), H, variance: Array(3).fill(observation.variance) as number[] };
  };
  // Schmidt nuisance bias: retain its uncertainty/correlations, but do not
  // calibrate it from ambiguous tilt/acceleration observations without GPS.
  const restrict = observation.time - s.lastVelocityFusion < 2.5 ? undefined : (gain: Float64Array) => gain.fill(0, 9 * 3, 12 * 3);
  const recover = s.reacquiring && observation.time - s.tilt.quietSince >= 1;
  const { residual, H, variance } = model(s);
  const seed = recover ? multiply(s.q, rotationBetween(sub(observation.force, s.ba), sub(gravityModel(s).expected, s.ba))) : undefined;
  const result = recover ? correctIterated(s, model, s.tilt, 'tilt', observation.time, publish, restrict, seed)
    : correct(s, residual, H, variance, s.tilt, publish ? { source: 'tilt', time: observation.time, publish } : undefined, restrict);
  if (result === 'attitude-limit' && !s.reacquiring) {
    s.reacquiring = true;
    s.tilt.quietSince = quiet ? observation.time : Infinity;
  }
  if (result !== 'accepted') return;
  s.tilt.lastFusion = observation.time;
  s.tilt.source = 'imu';
  s.tilt.reason = recover ? 'Nonlinear gravity/acceleration reacquisition' : 'Gravity and kinematic acceleration jointly fused';
  if (recover && tiltStd(s) < config.maxTiltStd) s.reacquiring = false;
}
