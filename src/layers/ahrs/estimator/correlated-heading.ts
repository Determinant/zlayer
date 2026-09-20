import { cloneState, correct, type NavState, type ObservationSink } from './eskf.js';
import { correctIterated, type CorrectionModel } from './nonlinear-correction.js';
import { sandwich, type Matrix } from './linalg.js';
import { RAD, type Quaternion } from './math.js';
import { ACCELERATION, MAGNETIC_BIAS, MAGNETIC_BIAS_STD, MAGNETIC_FIELD, N, TRANSIENT_ACCELERATION } from './state-layout.js';
import type { AhrsOptions, CorrectionResult, Observation } from './types.js';

const attitudeVariance = (state: NavState) => state.P[6 * N + 6]! + state.P[7 * N + 7]! + state.P[8 * N + 8]!;

/** A fixed, dimensionless trace metric for the retained attitude/calibration
 * marginal. Initial variances set units, not covariance floors. In particular,
 * repeated heading updates must pay for inflation of the acceleration and bias
 * hypotheses on which subsequent attitude corrections depend. Unobserved p/v
 * origins do not determine whether a relative heading observation is useful.
 */
export function headingFusionCost(s: NavState, c: Required<AhrsOptions>): number {
  let cost = 0;
  for (const [offset, variance] of [[6, (c.initialTiltStd * RAD) ** 2], [9, c.initialAccelBiasStd ** 2],
    [12, c.initialGyroBiasStd ** 2], [ACCELERATION, c.initialAccelerationStd ** 2],
    [MAGNETIC_FIELD, 1], [MAGNETIC_BIAS, MAGNETIC_BIAS_STD ** 2],
    [TRANSIENT_ACCELERATION, c.accelerationWalk ** 2 * c.accelerationTimeConstant / 2]] as const)
    for (let axis = 0; axis < 3; axis++) cost += s.P[(offset + axis) * N + offset + axis]! / variance;
  return cost;
}

/** Generalized covariance intersection bounds unknown shared sensor errors.
 * The restricted gain may alter heading only; Joseph still updates ALL blocks.
 * Include the unchanged prior as a candidate: a correlated reading is admitted
 * only if both attitude variance and the retained-state cost decrease. The
 * fixed positive cost prevents compass updates alone from compounding nuisance
 * inflation without bound. No cross-covariance is dropped to make fusion cheaper.
 */
export function correctCorrelatedHeading(s: NavState, model: CorrectionModel, time: number,
  config: Required<AhrsOptions>, restrictGain: (gain: Matrix) => void,
  publish?: ObservationSink, recoverySeed?: Quaternion): CorrectionResult | 'uninformative' {
  const { residual, H, variance } = model(s);
  // A CI weight protects the posterior against shared errors; its inflated
  // observation variance must not make arbitrarily large field jumps pass the
  // sensor gate. Cauchy–Schwarz bounds the scalar innovation variance for any
  // prior/measurement correlation by (sqrt(H P Hᵀ) + sqrt(R))².
  const predicted = Math.max(0, sandwich(H, s.P, 1, N)[0]!);
  const bound = (Math.sqrt(predicted) + Math.sqrt(variance[0]!)) ** 2;
  const nis = residual[0]! ** 2 / bound, gate = 10.828;
  if (!Number.isFinite(nis) || nis > gate) {
    s.magnetic.rejected++;
    s.magnetic.nis = Number.isFinite(nis) ? nis : null;
    s.magnetic.reason = 'Measurement innovation rejected';
    publish?.({ source: 'magnetic', time, dimension: 1, residual: [...residual],
      covariance: [bound], nis: s.magnetic.nis, gate, result: 'innovation' });
    return 'innovation';
  }
  let best: NavState | undefined, bestObservation: Observation | undefined;
  let score = headingFusionCost(s, config);
  const attitude = attitudeVariance(s);
  let valid = false;
  let failure: { state: NavState; observation: Observation | undefined; result: CorrectionResult } | undefined;
  for (const weight of [.995, .99, .98, .95, .9, .8, .65, .5]) {
    const candidate = cloneState(s);
    let observation: Observation | undefined;
    const record = (value: Observation) => { observation = value; };
    const result = recoverySeed
      ? correctIterated(candidate, model, candidate.magnetic, 'magnetic', time, record, restrictGain, recoverySeed, weight)
      : correct(candidate, residual, H, variance, candidate.magnetic,
        { source: 'magnetic', time, publish: record }, restrictGain, { priorWeight: weight });
    if (result !== 'accepted') { failure = { state: candidate, observation, result }; continue; }
    valid = true;
    const candidateScore = headingFusionCost(candidate, config);
    if (candidateScore < score * (1 - 1e-8) && attitudeVariance(candidate) < attitude * (1 - 1e-8)) {
      best = candidate; bestObservation = observation; score = candidateScore;
    }
  }
  if (best) {
    Object.assign(s, best);
    if (bestObservation) publish?.(bestObservation);
    return 'accepted';
  }
  // A valid but redundant observation is not a sensor fault.
  if (!valid && failure) {
    s.magnetic = failure.state.magnetic;
    if (failure.observation) publish?.(failure.observation);
    return failure.result;
  }
  s.magnetic.reason = 'Correlated heading benefit does not outweigh retained-state uncertainty';
  publish?.({ source: 'magnetic', time, dimension: residual.length, residual: [...residual],
    covariance: null, nis: null, gate: null, result: 'uninformative' });
  return 'uninformative';
}
