import { correct, tiltStd, angleStd, type NavState, type ObservationSink } from './eskf.js';
import { correctIterated } from './nonlinear-correction.js';
import { correctCorrelatedHeading } from './correlated-heading.js';
import { add, conjugate, dot, integrate, norm, RAD, rotate, rotationMatrix, scale, sub, unit, type Vec3 } from './math.js';
import { cholesky, identity, product, sandwich, skew, solve, symmetrize, transpose, zeros, type Matrix } from './linalg.js';
import { MAGNETIC_BIAS, MAGNETIC_BIAS_STD, MAGNETIC_FIELD, N } from './state-layout.js';
import type { AhrsOptions, MagneticSample } from './types.js';

const VECTOR_NOISE = .035; // fraction of the initial field magnitude
const wrapAngle = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));
const azimuth = (v: Vec3) => Math.atan2(v[1], v[0]);
const azimuthGradient = (v: Vec3): Vec3 => {
  const horizontal = v[0] ** 2 + v[1] ** 2;
  return [-v[1] / horizontal, v[0] / horizontal, 0];
};

/** m_body = Rᵀ m_world + b_m_body, in fixed normalized field units. */
export function magneticModel(s: NavState) {
  const field = rotate(conjugate(s.q), s.magneticField), D = skew(field);
  const Rt = transpose(rotationMatrix(s.q), 3, 3), H = zeros(3, N);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    H[i * N + 6 + j] = D[i * 3 + j]!;
    H[i * N + MAGNETIC_FIELD + j] = Rt[i * 3 + j]!;
    H[i * N + MAGNETIC_BIAS + j] = i === j ? 1 : 0;
  }
  return { expected: add(field, s.magneticBias), H };
}

/** Replace a learned reference with its Jacobian, including all cross-covariance.
 * The qualified seed reading defines a relative anchor; it observes no attitude.
 */
function seedReference(s: NavState, value: Vec3, J: Matrix, noise: Matrix): void {
  const transform = identity(N);
  for (let i = 0; i < 3; i++) {
    transform.fill(0, (MAGNETIC_FIELD + i) * N, (MAGNETIC_FIELD + i + 1) * N);
    transform.set(J.subarray(i * N, (i + 1) * N), (MAGNETIC_FIELD + i) * N);
  }
  s.P = sandwich(transform, s.P, N, N);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
    s.P[(MAGNETIC_FIELD + i) * N + MAGNETIC_FIELD + j]! += noise[i * 3 + j]!;
  s.magneticField = value;
  symmetrize(s.P, N);
}

function initialize(s: NavState, sample: MagneticSample, scaleFactor: number, qualifiedSince: number): void {
  // A different provider has a different calibration/offset. Preserve attitude,
  // discard the previous provider's nuisance bias and reference correlations.
  s.magneticBias = [0, 0, 0];
  for (let i = MAGNETIC_BIAS; i < MAGNETIC_BIAS + 3; i++) {
    for (let j = 0; j < N; j++) s.P[i * N + j] = s.P[j * N + i] = 0;
    s.P[i * N + i] = MAGNETIC_BIAS_STD ** 2;
  }
  const R = rotationMatrix(s.q), J = zeros(3, N), noise = zeros(3);
  let initialVariance: number | undefined;
  if (sample.source === 'webkit-compass') {
    const worldAxis = rotate(s.q, sample.axis), angle = azimuth(worldAxis) - sample.heading * RAD;
    const value: Vec3 = [Math.cos(angle), Math.sin(angle), 0], tangent: Vec3 = [-value[1], value[0], 0];
    const derivative = product(R, skew(sample.axis), 3, 3, 3), gradient = azimuthGradient(worldAxis);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
      J[i * N + 6 + j] = -tangent[i]! * gradient.reduce((sum, x, k) => sum + x * derivative[k * 3 + j]!, 0);
    initialVariance = (Math.max(5, sample.accuracy) * RAD) ** 2;
    seedReference(s, value, J, noise);
  } else {
    const vector = scale(sample.vector, 1 / scaleFactor), derivative = product(R, skew(vector), 3, 3, 3);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      J[i * N + 6 + j] = -derivative[i * 3 + j]!;
      if (sample.source === 'magnetometer') J[i * N + MAGNETIC_BIAS + j] = -R[i * 3 + j]!;
    }
    const world = rotate(s.q, vector);
    if (sample.source === 'magnetometer') for (let i = 0; i < 3; i++) noise[i * 3 + i] = VECTOR_NOISE ** 2;
    else initialVariance = (5 * RAD / Math.hypot(world[0], world[1])) ** 2;
    // An OS reference is defined by the reported initial datum. Its sensor
    // error remains in each relative observation, bounded there with CI.
    seedReference(s, world, J, noise);
  }
  s.magneticReference = { source: sample.source, scale: scaleFactor,
    ...(initialVariance === undefined ? {} : { initialVariance }) };
  s.magnetic.candidate = null;
  s.magnetic.recoveryCandidate = null;
  s.magnetic.lastSample = sample.time;
  s.magnetic.lastFusion = -Infinity;
  s.magnetic.blockedUntil = -Infinity;
  s.magnetic.mode = 'qualifying';
  s.magnetic.healthySince = qualifiedSince;
  s.magnetic.innovationMean = [0, 0, 0];
  s.magnetic.innovationEnergy = 0;
  s.magnetic.rotationMean = R;
  s.magnetic.excitationSince = sample.time;
  s.magnetic.reacquiring = false;
  s.magnetic.reason = 'Relative magnetic reference initialized';
}

/** Browser orientation shares OS inertial inputs. Allow heading correction only;
 * a restricted Joseph update retains its effects on every covariance block. */
function headingGain(s: NavState, gain: Matrix, dimension = 1): void {
  const down = rotate(conjugate(s.q), [0, 0, 1]);
  const original = gain.slice();
  gain.fill(0);
  for (let column = 0; column < dimension; column++) for (const offset of [6, 12]) {
    const alongDown = dot(down, [original[offset * dimension + column]!, original[(offset + 1) * dimension + column]!, original[(offset + 2) * dimension + column]!]);
    for (let i = 0; i < 3; i++) gain[(offset + i) * dimension + column] = down[i]! * alongDown;
  }
}

/** Bias/reference separation needs rotation about more than one axis. The
 * Schur complement I - mean(R) mean(R)ᵀ measures that excitation over 10 s.
 * A Schmidt update freezes unqualified means while retaining their covariance.
 */
function calibrationObservable(s: NavState, time: number, dt: number): boolean {
  const R = rotationMatrix(s.q), mean = s.magnetic.rotationMean;
  if (dt > 1) { mean.set(R); s.magnetic.excitationSince = time; }
  const gain = -Math.expm1(-dt / 10);
  for (let i = 0; i < 9; i++) mean[i]! += gain * (R[i]! - mean[i]!);
  const gram = product(mean, transpose(mean, 3, 3), 3, 3, 3);
  for (let i = 0; i < 9; i++) gram[i] = (i % 4 === 0 ? .98 : 0) - gram[i]!;
  return time - s.magnetic.excitationSince >= 3 && cholesky(gram, 3) !== null;
}

/** Scalar compass constraint. H is minus the state derivative of residual. */
export function compassModel(s: NavState, sample: Exclude<MagneticSample, { source: 'magnetometer' }>) {
  const axis = sample.source === 'webkit-compass' ? sample.axis : sample.vector;
  const worldAxis = rotate(s.q, axis), field = s.magneticField;
  const residual = [wrapAngle(azimuth(worldAxis) - (sample.source === 'webkit-compass' ? sample.heading * RAD : 0) - azimuth(field))];
  const D = product(rotationMatrix(s.q), skew(axis), 3, 3, 3), gradient = azimuthGradient(worldAxis);
  const H = zeros(1, N);
  for (let j = 0; j < 3; j++) H[6 + j] = gradient.reduce((sum, x, i) => sum + x * D[i * 3 + j]!, 0);
  H.set(azimuthGradient(field), MAGNETIC_FIELD);
  const angularNoise = Math.max(5, sample.source === 'webkit-compass' ? sample.accuracy : 5) * RAD;
  // OS vector noise is magnified by projection. Safari already reports scalar
  // heading accuracy, so its variance is in azimuth coordinates directly.
  const projection = sample.source === 'absolute-orientation' ? Math.hypot(worldAxis[0], worldAxis[1]) : 1;
  // Var(e_t - e_0) <= 2 (R_t + R_0), even for correlated OS errors.
  // CI additionally bounds correlation with the current state and prior uses.
  return { residual, H, variance: [2 * ((angularNoise / projection) ** 2 + (s.magneticReference?.initialVariance ?? 0))] };
}

/** Temporal consistency only: neither reference nor covariance changes here. */
function advanceCandidate(s: NavState, sample: MagneticSample, strength: number,
  candidate: NavState['magnetic']['candidate']): NonNullable<NavState['magnetic']['candidate']> {
  let world: Vec3;
  if (sample.source === 'webkit-compass') {
    const angle = azimuth(rotate(s.q, sample.axis)) - sample.heading * RAD;
    world = [Math.cos(angle), Math.sin(angle), 0];
  } else world = unit(rotate(s.q, sample.vector));
  const tolerance = Math.max(15, sample.source === 'webkit-compass' ? 3 * sample.accuracy : 15) * RAD;
  if (!candidate || candidate.source !== sample.source || sample.time - candidate.last > 1 ||
    Math.abs(strength / candidate.strength - 1) > .15 || dot(world, candidate.world) < Math.cos(tolerance))
    return { source: sample.source, since: sample.time, last: sample.time, world, strength, samples: 1 };
  return { ...candidate, last: sample.time, samples: candidate.samples + 1 };
}
const candidateQualified = (candidate: NonNullable<NavState['magnetic']['candidate']>) =>
  candidate.last - candidate.since >= 2 - 1e-9 && candidate.samples >= 4;

const priority = { magnetometer: 3, 'absolute-orientation': 2, 'webkit-compass': 1 };

export function fuseMagnetic(s: NavState, sample: MagneticSample, config: Required<AhrsOptions>, publish?: ObservationSink): void {
  const interval = sample.source === 'magnetometer' ? .1 : .5;
  const reference = s.magneticReference;
  const switching = !reference || reference.source !== sample.source;
  const activeFresh = reference && sample.time - s.magnetic.lastSample < 1.5 && s.magnetic.mode !== 'rejected';
  if (switching && activeFresh && priority[sample.source] <= priority[reference.source]) return;
  const previousTime = switching ? s.magnetic.candidate?.source === sample.source ? s.magnetic.candidate.last : -Infinity
    : s.magnetic.lastSample;
  if (sample.time - previousTime < interval - 1e-9) return;
  const dt = sample.time - previousTime;
  if (!switching) s.magnetic.lastSample = sample.time;
  const reject = (reason: string, innovation?: { residual: Vec3; covariance: Matrix; nis: number }) => {
    s.magnetic.rejected++;
    if (switching) s.magnetic.candidate = null;
    if (!switching || !activeFresh) {
      s.magnetic.nis = innovation?.nis ?? null;
      s.magnetic.reason = reason;
      s.magnetic.blockedUntil = sample.time + 2;
      s.magnetic.healthySince = Infinity;
      s.magnetic.recoveryCandidate = null;
      s.magnetic.mode = 'rejected';
    }
    publish?.({ source: 'magnetic', time: sample.time, dimension: innovation ? 3 : 0,
      residual: innovation ? [...innovation.residual] : [], covariance: innovation ? Array.from(innovation.covariance) : null,
      nis: innovation?.nis ?? null, gate: innovation ? 16.266 : null, result: innovation ? 'innovation' : 'geometry' });
  };
  let strength = 1;
  if (sample.source === 'webkit-compass') {
    if (!Number.isFinite(sample.heading) || !Number.isFinite(sample.accuracy) || sample.accuracy < 0 || sample.accuracy > 20 ||
      Math.abs(norm(sample.axis) - 1) > .01) return reject('Invalid browser compass accuracy or axis');
    if (Math.hypot(...rotate(s.q, sample.axis).slice(0, 2)) < .2) return reject('Compass reference axis is near vertical');
  } else {
    strength = norm(sample.vector);
    if (sample.source === 'magnetometer' ? strength < 15 || strength > 100 : Math.abs(strength - 1) > .01)
      return reject('Magnetic vector magnitude outside supported range');
    if (sample.source === 'absolute-orientation' && Math.hypot(...rotate(s.q, sample.vector).slice(0, 2)) < .2)
      return reject('Browser north vector has weak horizontal projection');
  }
  if (switching) {
    const candidate = s.magnetic.candidate = advanceCandidate(s, sample, strength, s.magnetic.candidate);
    if (candidateQualified(candidate)) {
      initialize(s, sample, strength, candidate.since);
      publish?.({ source: 'magnetic', time: sample.time, dimension: 0, residual: [], covariance: null,
        nis: null, gate: null, result: 'initialized' });
    } else if (!activeFresh) {
      s.magnetic.mode = 'qualifying';
      s.magnetic.reason = 'Qualifying a provisional magnetic reference';
    }
    return;
  }
  // Missing magnetic samples do not imply missing IMU rotation. Retain the
  // actual prior and enable nonlinear recovery before the linear NIS gate.
  if (dt > 1) s.magnetic.reacquiring = true;
  if (sample.time < s.magnetic.blockedUntil) return;
  if (dt > 1 || !Number.isFinite(s.magnetic.healthySince)) {
    s.magnetic.healthySince = sample.time;
    s.magnetic.innovationMean = [0, 0, 0];
    s.magnetic.innovationEnergy = 0;
  }
  let qualified = sample.time - s.magnetic.healthySince >= 2 - 1e-9;
  const excitation = calibrationObservable(s, sample.time, Math.min(dt, 30));
  let residual: readonly number[], H: Matrix, variance: number[];
  if (sample.source === 'magnetometer') {
    const model = magneticModel(s), vector = scale(sample.vector, 1 / reference!.scale);
    // Fixed units retain strength evidence; per-reading normalization would hide it.
    if (Math.abs(norm(vector) - norm(model.expected)) > .2) return reject('Magnetic field strength changed');
    residual = sub(vector, model.expected); H = model.H; variance = Array(3).fill(VECTOR_NOISE ** 2);
    const world = rotate(s.q, sub(vector, s.magneticBias)), field = s.magneticField;
    const dipError = Math.abs(world[2] / norm(world) - field[2] / norm(field));
    if (!Number.isFinite(dipError) || dipError > Math.max(.15, 3 * tiltStd(s) * RAD)) return reject('Magnetic inclination disagrees with tilt evidence');
    if (!s.magnetic.reacquiring) {
      const covariance = sandwich(H, s.P, 3, N), vectorResidual = residual as Vec3;
      for (let i = 0; i < 3; i++) covariance[i * 3 + i]! += VECTOR_NOISE ** 2;
      const L = cholesky(covariance, 3);
      if (!L) return reject('Invalid magnetic innovation covariance');
      const solved = solve(L, residual, 3), nis = residual.reduce((sum, value, i) => sum + value * solved[i]!, 0);
      if (!Number.isFinite(nis) || nis > 16.266) {
        if (Number.isFinite(nis) && angleStd(s)[2] >= 20) s.magnetic.reacquiring = true;
        return reject('Magnetic innovation outside qualification range', { residual: vectorResidual, covariance, nis });
      }
      // Normalize by predicted error, including uncertain attitude/reference,
      // so a legitimate attitude error is not mislabeled as a field fault.
      const rms = Math.sqrt(covariance[0]! + covariance[4]! + covariance[8]!);
      const evidence = scale(rotate(s.q, vectorResidual), 1 / rms), gain = -Math.expm1(-Math.min(dt, 1) / 5);
      s.magnetic.innovationMean = add(scale(s.magnetic.innovationMean, 1 - gain), scale(evidence, gain));
      s.magnetic.innovationEnergy += gain * (nis / 3 - s.magnetic.innovationEnergy);
      if (sample.time - s.magnetic.healthySince > 5 && (norm(s.magnetic.innovationMean) > 1.5 || s.magnetic.innovationEnergy > 3))
        return reject('Persistent magnetic innovation');
    }
  } else {
    if (Math.hypot(s.magneticField[0], s.magneticField[1]) < .2) return reject('Relative compass reference is ill-conditioned');
    ({ residual, H, variance } = compassModel(s, sample));
  }
  if (s.magnetic.reacquiring) {
    const candidate = s.magnetic.recoveryCandidate = advanceCandidate(s, sample, strength, s.magnetic.recoveryCandidate);
    qualified &&= candidateQualified(candidate);
  }
  if (!qualified) { s.magnetic.mode = 'qualifying'; s.magnetic.reason = 'Qualifying magnetic consistency'; return; }
  const raw = sample.source === 'magnetometer';
  const tiltQualified = sample.time - s.tilt.lastFusion < 1 && tiltStd(s) < 10;
  if (s.magnetic.reacquiring && !tiltQualified) {
    s.magnetic.mode = 'qualifying';
    s.magnetic.reason = 'Waiting for qualified tilt before magnetic reacquisition';
    return;
  }
  const fullVector = raw && tiltQualified;
  s.magnetic.mode = fullVector ? 'vector' : 'heading';
  const restrict = (gain: Matrix) => {
    if (!fullVector) { headingGain(s, gain, residual.length); return; }
    if (!excitation || s.magnetic.reacquiring) gain.fill(0, MAGNETIC_BIAS * 3, (MAGNETIC_BIAS + 3) * 3);
    if (!excitation || s.magnetic.reacquiring || sample.time - s.lastVelocityFusion >= 2.5) gain.fill(0, MAGNETIC_FIELD * 3, (MAGNETIC_FIELD + 3) * 3);
    if (sample.time - s.lastVelocityFusion >= 2.5) gain.fill(0, 9 * 3, 12 * 3);
  };
  const recover = tiltQualified && s.magnetic.reacquiring;
  const measuredWorld = raw ? rotate(s.q, sub(scale(sample.vector, 1 / reference!.scale), s.magneticBias)) : null;
  const headingCorrection = raw
    ? measuredWorld && Math.hypot(measuredWorld[0], measuredWorld[1]) > .2
      ? wrapAngle(azimuth(s.magneticField) - azimuth(measuredWorld)) : null
    : -residual[0]!;
  const seed = recover && headingCorrection !== null
    ? integrate(s.q, rotate(conjugate(s.q), [0, 0, headingCorrection]), 1) : undefined;
  const result = !raw ? correctCorrelatedHeading(s, state => compassModel(state, sample), sample.time, config, restrict, publish, seed)
    : recover ? correctIterated(s, state => {
      const model = magneticModel(state);
      return { residual: sub(scale(sample.vector, 1 / state.magneticReference!.scale), model.expected), H: model.H, variance };
    }, s.magnetic, 'magnetic', sample.time, publish, restrict, seed)
    : correct(s, residual, H, variance, s.magnetic, publish ? { source: 'magnetic', time: sample.time, publish } : undefined, restrict);
  if (result === 'uninformative') return;
  if (result !== 'accepted') {
    if (result === 'attitude-limit') s.magnetic.reacquiring = true;
    s.magnetic.blockedUntil = sample.time + 2; s.magnetic.healthySince = Infinity; s.magnetic.recoveryCandidate = null;
    s.magnetic.mode = 'rejected'; return;
  }
  if (recover && angleStd(s)[2] < 20) { s.magnetic.reacquiring = false; s.magnetic.recoveryCandidate = null; }
  s.magnetic.lastFusion = sample.time;
  s.magnetic.reason = raw ? (fullVector ? 'Qualified three-axis magnetic fusion' : 'Magnetic heading-only fusion')
    : recover ? 'Nonlinear correlated-heading reacquisition' : 'Correlated heading fusion';
}
