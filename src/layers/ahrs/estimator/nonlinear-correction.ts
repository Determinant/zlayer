import { cloneState, correct, type NavState, type ObservationSink } from './eskf.js';
import { conjugate, multiply, norm, rightJacobian, scale, sub, type Quaternion, type Vec3 } from './math.js';
import { identity, product, type Matrix } from './linalg.js';
import { N } from './state-layout.js';
import type { CorrectionResult, Observation } from './types.js';

export type CorrectionModel = (state: NavState) => { residual: readonly number[]; H: Matrix; variance: readonly number[] };
type Statistics = NavState['tilt'] | NavState['magnetic'];

function difference(reference: NavState, state: NavState): Matrix {
  const error = new Float64Array(N), q = multiply(conjugate(reference.q), state.q);
  const sign = q[0] < 0 ? -1 : 1, v: Vec3 = [q[1] * sign, q[2] * sign, q[3] * sign], length = norm(v);
  error.set(scale(v, length < 1e-10 ? 2 : 2 * Math.atan2(length, Math.abs(q[0])) / length), 6);
  for (const [offset, key] of [[0, 'p'], [3, 'v'], [9, 'ba'], [12, 'bg'], [15, 'acceleration'],
    [18, 'magneticField'], [21, 'magneticBias'], [24, 'transientAcceleration'], [27, 'velocityAnchor']] as const)
    error.set(sub(state[key], reference[key]), offset);
  return error;
}

/** Iterated MAP update for reacquisition. Every iteration uses the SAME prior;
 * covariance and diagnostics are committed once. Re-linearization therefore
 * never counts a single observation multiple times. The final covariance lives
 * in the final quaternion tangent, through correct()'s reset Jacobian.
 */
export function correctIterated(s: NavState, model: CorrectionModel, statistics: Statistics,
  source: Observation['source'], time: number, publish?: ObservationSink,
  restrictGain?: (gain: Matrix) => void, initialAttitude?: Quaternion, priorWeight = 1): CorrectionResult {
  let iterate = cloneState(s);
  if (initialAttitude) iterate.q = initialAttitude;
  let error: Matrix = difference(s, iterate);
  let finalModel: ReturnType<CorrectionModel> | undefined;
  const options = { maxAttitudeCorrection: Math.PI, priorWeight };
  for (let iteration = 0; iteration < 12; iteration++) {
    const emit = publish ? (observation: Observation) => publish({ ...observation, iterations: iteration + 1 }) : undefined;
    const observation = model(iterate), transform = identity(N);
    const J = rightJacobian([error[6]!, error[7]!, error[8]!]);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) transform[(6 + i) * N + 6 + j] = J[i * 3 + j]!;
    const H = product(observation.H, transform, observation.residual.length, N, N);
    const offset = product(H, error, observation.residual.length, N, 1);
    finalModel = { H, variance: observation.variance, residual: observation.residual.map((value, i) => value + offset[i]!) };
    const candidate = cloneState(s), trialStatistics = { ...statistics };
    const result = correct(candidate, finalModel.residual, H, finalModel.variance, trialStatistics, undefined,
      restrictGain, options);
    if (result !== 'accepted') {
      // Publish the actual failed innovation once, using the unchanged prior.
      return correct(s, finalModel.residual, H, finalModel.variance, statistics,
        emit ? { source, time, publish: emit } : undefined, restrictGain, options);
    }
    const nextError = difference(s, candidate);
    const change = nextError.reduce((maximum, value, i) => Math.max(maximum,
      Math.abs(value - error[i]!) / (1 + Math.abs(value))), 0);
    iterate = candidate;
    error = nextError;
    if (change < 1e-5) return correct(s, finalModel.residual, H, finalModel.variance, statistics,
      emit ? { source, time, publish: emit } : undefined, restrictGain, options);
  }
  statistics.rejected++;
  statistics.nis = null;
  statistics.reason = 'Nonlinear attitude reacquisition did not converge';
  publish?.({ source, time, dimension: finalModel?.residual.length ?? 0, residual: [...(finalModel?.residual ?? [])],
    covariance: null, nis: null, gate: null, result: 'iteration-limit', iterations: 12,
    ...(priorWeight === 1 ? {} : { priorWeight }) });
  return 'iteration-limit';
}
