import { RAD, eulerJacobian } from './math.js';
import { cholesky, product, rightSolve, solve, transpose, zeros, type Matrix } from './linalg.js';
import { N } from './state-layout.js';
import type { NavState } from './eskf.js';
import type { GpsFix } from './types.js';
import { MIN_FLIGHT_GPS_SPEED } from './flight-alignment.js';

type Evidence = { state: NavState; transition: Matrix };
type Pair = Evidence & { time: number; gps: readonly number[]; noise: number };
type Alignment = { offsetRadians: number; headingStdDegrees: number };

/** Cov(error_later, error_earlier) = Phi(later,earlier) P_earlier.
 * The trajectory never receives corrections, so its fundamental transitions
 * preserve the shared seed, bias and integrated process-noise correlations. */
function crossCovariance(later: Evidence, earlier: Evidence): Matrix | null {
  const transition = rightSolve(later.transition, earlier.transition, N);
  return transition ? product(transition, earlier.state.P, N, N, N) : null;
}

/** Global yaw initializer followed by generalized least squares. Offset and
 * linear velocity drift are nuisance parameters, not heading observations.
 * Confirmation windows only qualify persistence; their information is never
 * accumulated as independent observations. */
export class MotionHeading {
  private pairs: Pair[] = [];
  private candidate: Alignment | null = null;
  private confirmations = 0;

  reset(): void { this.pairs = []; this.candidate = null; this.confirmations = 0; }

  observe(fix: GpsFix, evidence: Evidence, current: Evidence, velocityStd: number): Alignment | null {
    const gps = fix.velocityNed ?? (fix.speed !== null && fix.track !== null
      ? [fix.speed * Math.cos(fix.track * RAD), fix.speed * Math.sin(fix.track * RAD)] : null);
    if (!gps || fix.estimated || fix.accuracy > 50 || Math.hypot(gps[0]!, gps[1]!) < MIN_FLIGHT_GPS_SPEED) {
      this.reset(); return null;
    }
    const previous = this.pairs.at(-1);
    if (previous && fix.time - previous.time < 1 - 1e-6) return null;
    if (previous && fix.time - previous.time > 3) this.reset();
    this.pairs.push({ ...evidence, time: fix.time, gps: gps.slice(0, 2),
      noise: Math.max(velocityStd, fix.velocityStd?.[0] ?? 0, fix.velocityStd?.[1] ?? 0) });
    while (this.pairs[0]!.time < fix.time - 20) this.pairs.shift();
    const alignment = this.fit(current);
    if (!alignment) { this.candidate = null; this.confirmations = 0; return null; }
    const change = this.candidate ? Math.atan2(Math.sin(alignment.offsetRadians - this.candidate.offsetRadians),
      Math.cos(alignment.offsetRadians - this.candidate.offsetRadians)) : Infinity;
    this.confirmations = Math.abs(change) <= 5 * RAD ? this.confirmations + 1 : 1;
    this.candidate = alignment;
    return this.confirmations >= 3 ? alignment : null;
  }

  private fit(current: Evidence): Alignment | null {
    const pairs = this.pairs, count = pairs.length, dimension = count * 2;
    if (count < 8 || pairs.at(-1)!.time - pairs[0]!.time < 7) return null;
    const center = pairs.reduce((sum, pair) => sum + pair.time, 0) / count;
    const times = pairs.map(pair => pair.time - center), timeEnergy = times.reduce((sum, time) => sum + time * time, 0);
    const detrend = (values: readonly (readonly number[])[]) => {
      const mean = [0, 1].map(axis => values.reduce((sum, value) => sum + value[axis]!, 0) / count);
      const slope = [0, 1].map(axis => values.reduce((sum, value, i) => sum + times[i]! * value[axis]!, 0) / timeEnergy);
      return values.map((value, i) => [0, 1].map(axis => value[axis]! - mean[axis]! - slope[axis]! * times[i]!));
    };
    const inertial = detrend(pairs.map(pair => pair.state.v)), gps = detrend(pairs.map(pair => pair.gps));
    let dot = 0, cross = 0, inertialEnergy = 0, gpsEnergy = 0;
    for (let i = 0; i < count; i++) {
      const [x, y] = inertial[i]! as [number, number], [n, e] = gps[i]! as [number, number];
      dot += x * n + y * e; cross += x * e - y * n;
      inertialEnergy += x * x + y * y; gpsEnergy += n * n + e * e;
    }
    const noise = Math.max(...pairs.map(pair => pair.noise));
    if (Math.min(inertialEnergy, gpsEnergy) < count * (3 * noise) ** 2 ||
      Math.hypot(dot, cross) < .95 * Math.sqrt(inertialEnergy * gpsEnergy) ||
      gpsEnergy / inertialEnergy < .75 ** 2 || gpsEnergy / inertialEnergy > 1.33 ** 2) return null;

    const covariance = zeros(dimension), yawCross = new Float64Array(dimension);
    const yawGradient = eulerJacobian(current.state.q)?.subarray(6, 9);
    if (!yawGradient) return null;
    let yawVariance = 0;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
      yawVariance += yawGradient[i]! * current.state.P[(6 + i) * N + 6 + j]! * yawGradient[j]!;
    for (let i = 0; i < count; i++) {
      const nowCross = crossCovariance(current, pairs[i]!);
      if (!nowCross) return null;
      for (let axis = 0; axis < 2; axis++) for (let k = 0; k < 3; k++)
        yawCross[2 * i + axis]! += yawGradient[k]! * nowCross[(6 + k) * N + 3 + axis]!;
      for (let j = 0; j <= i; j++) {
        const block = i === j ? pairs[i]!.state.P : crossCovariance(pairs[i]!, pairs[j]!);
        if (!block) return null;
        for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) {
          const value = block[(3 + a) * N + 3 + b]!;
          covariance[(2 * i + a) * dimension + 2 * j + b] = value;
          covariance[(2 * j + b) * dimension + 2 * i + a] = value;
        }
      }
    }

    const parameters = new Float64Array([Math.atan2(cross, dot), 0, 0, 0, 0]);
    let offsetVariance = Infinity, headingVariance = Infinity;
    for (let iteration = 0; iteration < 10; iteration++) {
      const c = Math.cos(parameters[0]!), s = Math.sin(parameters[0]!), rotation = [c, -s, s, c];
      const S = zeros(dimension), J = zeros(dimension, 5), residual = new Float64Array(dimension);
      for (let i = 0; i < count; i++) {
        const pair = pairs[i]!, [x, y] = pair.state.v, n = c * x - s * y, e = s * x + c * y;
        residual[2 * i] = pair.gps[0]! - n - parameters[1]! - parameters[3]! * times[i]!;
        residual[2 * i + 1] = pair.gps[1]! - e - parameters[2]! - parameters[4]! * times[i]!;
        J[(2 * i) * 5] = -e; J[(2 * i + 1) * 5] = n;
        J[(2 * i) * 5 + 1] = 1; J[(2 * i + 1) * 5 + 2] = 1;
        J[(2 * i) * 5 + 3] = times[i]!; J[(2 * i + 1) * 5 + 4] = times[i]!;
        for (let j = 0; j < count; j++) for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) {
          let value = 0;
          for (let u = 0; u < 2; u++) for (let v = 0; v < 2; v++)
            value += rotation[a * 2 + u]! * covariance[(2 * i + u) * dimension + 2 * j + v]! * rotation[b * 2 + v]!;
          S[(2 * i + a) * dimension + 2 * j + b] = value + (i === j && a === b ? pair.noise ** 2 : 0);
        }
      }
      const L = cholesky(S, dimension);
      if (!L) return null;
      const solvedJ = zeros(dimension, 5);
      for (let column = 0; column < 5; column++) {
        const values = solve(L, Array.from({ length: dimension }, (_, i) => J[i * 5 + column]!), dimension);
        for (let i = 0; i < dimension; i++) solvedJ[i * 5 + column] = values[i]!;
      }
      const JT = transpose(J, dimension, 5), normal = product(JT, solvedJ, 5, dimension, 5), normalL = cholesky(normal, 5);
      if (!normalL) return null;
      const solvedResidual = solve(L, residual, dimension);
      const increment = solve(normalL, product(JT, solvedResidual, 5, dimension, 1), 5);
      if (Math.abs(increment[0]!) > .5) return null;
      for (let i = 0; i < 5; i++) parameters[i]! += increment[i]!;
      if (Math.max(...increment.map(Math.abs)) > 1e-5) continue;
      const nis = residual.reduce((sum, value, i) => sum + value * solvedResidual[i]!, 0);
      if (nis > 4 * (dimension - 5)) return null;
      const influence = solve(normalL, [1, 0, 0, 0, 0], 5);
      offsetVariance = influence[0]!;
      const weights = product(solvedJ, influence, dimension, 5, 1);
      let sharedYaw = 0;
      for (let i = 0; i < count; i++) {
        sharedYaw += weights[2 * i]! * (c * yawCross[2 * i]! - s * yawCross[2 * i + 1]!) +
          weights[2 * i + 1]! * (s * yawCross[2 * i]! + c * yawCross[2 * i + 1]!);
      }
      headingVariance = offsetVariance + yawVariance - 2 * sharedYaw;
      break;
    }
    if (!Number.isFinite(headingVariance) || headingVariance < -1e-8 * (offsetVariance + yawVariance)) return null;
    // Explicit model-discrepancy floor, not a substitute for trajectory covariance.
    const std = Math.sqrt(Math.max((5 * RAD) ** 2, headingVariance));
    return std <= 20 * RAD ? { offsetRadians: parameters[0]!, headingStdDegrees: std / RAD } : null;
  }
}
