import { cholesky } from '../../src/layers/ahrs/estimator/linalg';
import type { GpsFix, ImuSample } from '../../src/layers/ahrs/estimator/types';

// Independent analytic coordinated turn with a constant crosswind; no estimator
// quaternion or integration routines are used to manufacture these measurements.
export const gravity = 9.80665, radians = Math.PI / 180;

/** Synthetic level-flight reference: gentle ±0.8° rocking plus bounded vibration.
 * Angular vibration is small in displacement despite its higher instantaneous rate.
 */
export function vibratingLevelFlight(time: number): ImuSample {
  const slow = 2 * Math.PI * .2, fast = 2 * Math.PI * 8;
  const roll = (.8 * Math.sin(slow * time) + 5 / fast * Math.sin(fast * time)) * radians;
  return { time,
    gyro: [(.15 + .8 * slow * Math.cos(slow * time) + 5 * Math.cos(fast * time)) * radians, -.1 * radians, .2 * radians],
    specificForce: [.8 * Math.sin(fast * time), -gravity * Math.sin(roll) + 1.6 * Math.sin(2 * Math.PI * 6 * time),
      -gravity * Math.cos(roll) + .6 * Math.cos(2 * Math.PI * 10 * time)] };
}

export function turn(time: number, heading = 0) {
  const t = Math.max(0, time - 3), ramp = Math.min(t, 8), speed = 50;
  const rate = gravity * Math.tan(25 * radians) / speed;
  const yd = rate * (1 - Math.cos(Math.PI * ramp / 8)) / 2;
  const ydd = time < 3 || t >= 8 ? 0 : rate * Math.PI * Math.sin(Math.PI * ramp / 8) / 16;
  const yaw = heading * radians + rate * (ramp / 2 - 4 * Math.sin(Math.PI * ramp / 8) / Math.PI + Math.max(0, t - 8));
  const roll = Math.atan(speed * yd / gravity);
  const rd = speed / gravity * ydd / (1 + (speed * yd / gravity) ** 2);
  const cr = Math.cos(roll), sr = Math.sin(roll), cy = Math.cos(yaw), sy = Math.sin(yaw);
  const ax = -speed * yd * sy, ay = speed * yd * cy;
  const north = speed * cy + 12, east = speed * sy - 9;
  return { roll, yaw,
    sample: { time, gyro: [rd, yd * sr, yd * cr] as const,
      specificForce: [cy * ax + sy * ay, -sy * cr * ax + cy * cr * ay - sr * gravity,
        sy * sr * ax - cy * sr * ay - cr * gravity] as const },
    fix: { time, speed: Math.hypot(north, east), track: (Math.atan2(east, north) / radians + 360) % 360,
      accuracy: 3, altitude: null, altitudeAccuracy: null } satisfies GpsFix,
  };
}

/** Exact yaw gauges, deterministic reference seeds and velocity clones make the
 * joint covariance semidefinite. Regularization here is a checking tolerance;
 * it never changes the estimator or the covariance being asserted. */
export function covarianceIsPsd(covariance: Float64Array, dimension: number): boolean {
  if (covariance.length !== dimension * dimension || !covariance.every(Number.isFinite)) return false;
  const checked = covariance.slice();
  for (let i = 0; i < dimension; i++) {
    const tolerance = Math.max(1e-18, Math.abs(covariance[i * dimension + i]!) * 1e-12);
    if (covariance[i * dimension + i]! < -tolerance) return false;
    checked[i * dimension + i]! += tolerance;
    for (let j = 0; j < dimension; j++) if (Math.abs(covariance[i * dimension + j]! - covariance[j * dimension + i]!) >
      1e-12 * Math.max(1, Math.abs(covariance[i * dimension + j]!))) return false;
  }
  return cholesky(checked, dimension) !== null;
}
