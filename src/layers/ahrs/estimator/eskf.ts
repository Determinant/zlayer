import {
  G,
  RAD,
  add,
  conjugate,
  cross,
  eulerJacobian,
  forceIntegrals,
  integrate,
  norm,
  multiply,
  rotate,
  rotationMatrix,
  rightJacobian,
  scale,
  sub,
} from "./math.js";
import type { Quaternion, Vec3 } from "./math.js";
import {
  cholesky,
  identity,
  product,
  sandwich,
  skew,
  solve,
  symmetrize,
  transpose,
  zeros,
} from "./linalg.js";
import type { Matrix } from "./linalg.js";
import type { AhrsOptions, CorrectionResult, GpsFix, ImuSample, MagneticReference, MagneticSample, Observation } from "./types.js";
import { N, ACCELERATION, TRANSIENT_ACCELERATION, MAGNETIC_FIELD, MAGNETIC_BIAS, MAGNETIC_BIAS_STD, MAGNETIC_FIELD_WALK, MAGNETIC_BIAS_WALK, VELOCITY_ANCHOR } from "./state-layout.js";
export { N } from "./state-layout.js";

export const MAX_ATTITUDE_CORRECTION = 30 * RAD;
type Statistics = { accepted: number; rejected: number; nis: number | null; reason: string };
type MagneticCandidate = { source: MagneticSample['source']; since: number; last: number; world: Vec3; strength: number; samples: number };
export type ObservationSink = (observation: Observation) => void;
const GAUSS3 = [
  [0.5 - Math.sqrt(15) / 10, 5 / 18],
  [0.5, 4 / 9],
  [0.5 + Math.sqrt(15) / 10, 5 / 18],
] as const;
/** Error order: p, v, θ_body, ba, bg, a_persistent, m_world, bm, a_transient, v_anchor.
 * Local/right multiplicative error: q_true = q_nominal ⊗ Exp(δθ).
 * Solà (2017), sections 5–6, fixed known gravity specialization.
 */
export interface NavState {
  q: Quaternion;
  p: Vec3;
  v: Vec3;
  velocityAnchor: Vec3;
  gpsAnchor: { time: number; velocity: readonly [number, number]; variance: number } | null;
  ba: Vec3;
  bg: Vec3;
  acceleration: Vec3;
  transientAcceleration: Vec3;
  /** Smoothed body rate used only to schedule acceleration process noise. */
  accelerationRate: Vec3;
  reacquiring: boolean;
  magneticField: Vec3;
  magneticBias: Vec3;
  magneticReference: MagneticReference | null;
  P: Matrix;
  altitudeOrigin: number | null;
  accepted: number;
  rejected: number;
  lastVelocityFusion: number;
  velocityInitialized: boolean;
  verticalVelocityInitialized: boolean;
  velocityCorrection: CorrectionResult | null;
  lastVerticalVelocityFusion: number;
  lastGpsTime: number;
  lastAltitudeFusion: number;
  nis: number | null;
  reason: string;
  tilt: { source?: 'imu'; accepted: number; rejected: number; nis: number | null; reason: string; lastFusion: number; lastAttempt: number; quietSince: number };
  altitude: Statistics;
  magnetic: Statistics & { lastFusion: number; lastSample: number; blockedUntil: number;
    mode: 'qualifying' | 'heading' | 'vector' | 'rejected'; healthySince: number; reacquiring: boolean;
    innovationMean: Vec3; innovationEnergy: number; rotationMean: Matrix; excitationSince: number;
    candidate: MagneticCandidate | null; recoveryCandidate: MagneticCandidate | null };
}
export function cloneState(s: NavState): NavState {
  return {
    ...s,
    q: [...s.q],
    p: [...s.p],
    v: [...s.v],
    velocityAnchor: [...s.velocityAnchor],
    gpsAnchor: s.gpsAnchor ? { ...s.gpsAnchor, velocity: [...s.gpsAnchor.velocity] } : null,
    ba: [...s.ba],
    bg: [...s.bg],
    acceleration: [...s.acceleration],
    transientAcceleration: [...s.transientAcceleration],
    accelerationRate: [...s.accelerationRate],
    magneticField: [...s.magneticField],
    magneticBias: [...s.magneticBias],
    magneticReference: s.magneticReference ? { ...s.magneticReference } : null,
    P: s.P.slice(),
    tilt: { ...s.tilt },
    altitude: { ...s.altitude },
    magnetic: cloneMagnetic(s.magnetic),
  };
}
function cloneMagnetic(m: NavState['magnetic']): NavState['magnetic'] {
  return { ...m, innovationMean: [...m.innovationMean], rotationMean: m.rotationMean.slice(),
    candidate: m.candidate ? { ...m.candidate, world: [...m.candidate.world] } : null,
    recoveryCandidate: m.recoveryCandidate ? { ...m.recoveryCandidate, world: [...m.recoveryCandidate.world] } : null };
}
export function initialState(
  q: Quaternion,
  bg: Vec3,
  ba: Vec3,
  aligned: boolean,
  config: Required<AhrsOptions>,
  biasStd = config.initialGyroBiasStd,
): NavState {
  const P = zeros(N);
  for (let i = 0; i < 3; i++) {
    P[i * N + i] = 100 ** 2;
    P[(i + 3) * N + i + 3] = 20 ** 2;
    P[(i + 9) * N + i + 9] = config.initialAccelBiasStd ** 2;
    P[(i + 12) * N + i + 12] = biasStd ** 2;
    P[(i + ACCELERATION) * N + i + ACCELERATION] = config.initialAccelerationStd ** 2;
    P[(i + TRANSIENT_ACCELERATION) * N + i + TRANSIENT_ACCELERATION] = config.accelerationWalk ** 2 * config.accelerationTimeConstant / 2;
    P[(i + MAGNETIC_FIELD) * N + i + MAGNETIC_FIELD] = 1;
    P[(i + MAGNETIC_BIAS) * N + i + MAGNETIC_BIAS] = MAGNETIC_BIAS_STD ** 2;
  }
  // Express a world-vertical yaw uncertainty in local/body error coordinates.
  const R = rotationMatrix(q),
    tilt = (config.initialTiltStd * RAD) ** 2;
  // Before alignment the local-level frame's initial yaw is zero by definition.
  // Its unknown rotation to north is NOT a large Gaussian attitude error: tilt
  // updates must never make that absent absolute heading appear observable.
  const yaw = aligned ? (config.initialHeadingStd * RAD) ** 2 : 0;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      P[(i + 6) * N + j + 6] =
        (i === j ? tilt : 0) + (yaw - tilt) * R[6 + i]! * R[6 + j]!;
  return {
    q,
    p: [0, 0, 0],
    v: [0, 0, 0],
    velocityAnchor: [0, 0, 0],
    gpsAnchor: null,
    ba,
    bg,
    acceleration: [0, 0, 0],
    transientAcceleration: [0, 0, 0],
    accelerationRate: [0, 0, 0],
    reacquiring: false,
    magneticField: [0, 0, 0],
    magneticBias: [0, 0, 0],
    magneticReference: null,
    P,
    altitudeOrigin: null,
    accepted: 0,
    rejected: 0,
    lastVelocityFusion: -Infinity,
    velocityInitialized: false,
    verticalVelocityInitialized: false,
    velocityCorrection: null,
    lastVerticalVelocityFusion: -Infinity,
    lastGpsTime: -Infinity,
    lastAltitudeFusion: -Infinity,
    nis: null,
    reason: "Waiting for GPS velocity evidence",
    tilt: { accepted: 0, rejected: 0, nis: null, reason: "Waiting for accelerometer observations", lastFusion: -Infinity, lastAttempt: -Infinity, quietSince: Infinity },
    altitude: { accepted: 0, rejected: 0, nis: null, reason: "Waiting for GPS altitude" },
    magnetic: { accepted: 0, rejected: 0, nis: null, reason: 'Waiting for magnetic reference', lastFusion: -Infinity, lastSample: -Infinity, blockedUntil: -Infinity,
      mode: 'qualifying', healthySince: Infinity, reacquiring: false, innovationMean: [0, 0, 0], innovationEnergy: 0, rotationMean: identity(3), excitationSince: Infinity, candidate: null, recoveryCandidate: null },
  };
}

/** Start a new navigation trajectory, preserving the attitude/bias marginal
 * and cumulative diagnostics. Old position/velocity information belongs to the
 * previous frame/evidence window and must not enter a fresh alignment. */
export function restartNavigation(s: NavState, q: Quaternion, config: Required<AhrsOptions>): NavState {
  const next = initialState(q, [...s.bg], [...s.ba], false, config);
  for (let i = 6; i < VELOCITY_ANCHOR; i++) for (let j = 6; j < VELOCITY_ANCHOR; j++) next.P[i * N + j] = s.P[i * N + j]!;
  next.acceleration = [...s.acceleration];
  next.transientAcceleration = [...s.transientAcceleration];
  next.accelerationRate = [...s.accelerationRate];
  next.reacquiring = s.reacquiring;
  next.magneticField = [...s.magneticField];
  next.magneticBias = [...s.magneticBias];
  next.magneticReference = s.magneticReference ? { ...s.magneticReference } : null;
  next.accepted = s.accepted;
  next.rejected = s.rejected;
  next.nis = s.nis;
  next.tilt = { ...s.tilt };
  next.altitude = { ...s.altitude };
  next.magnetic = cloneMagnetic(s.magnetic);
  return next;
}
/** Continuous-time Jacobian; exported internally for independent finite-difference tests. */
export function dynamicsJacobian(
  q: Quaternion,
  force: Vec3,
  rate: Vec3,
): Matrix {
  const F = zeros(N),
    R = rotationMatrix(q),
    Rf = product(R, skew(force), 3, 3, 3),
    W = skew(rate);
  for (let i = 0; i < 3; i++) {
    F[i * N + i + 3] = 1;
    F[(i + 6) * N + i + 12] = -1;
    for (let j = 0; j < 3; j++) {
      F[(i + 3) * N + j + 6] = -Rf[i * 3 + j]!;
      F[(i + 3) * N + j + 9] = -R[i * 3 + j]!;
      F[(i + 6) * N + j + 6] = -W[i * 3 + j]!;
    }
  }
  return F;
}
/** Conventional strapdown propagation for the independent heading trajectory
 * and the explicit gravity-disabled INS mode. The default main filter instead
 * uses kinematics.ts and consumes force as an observation exactly once. */
export function predict(
  s: NavState,
  sample: ImuSample,
  dt: number,
  c: Required<AhrsOptions>,
): Matrix {
  if (dt <= 0) return identity(N);
  const rate = sub(sample.gyro, s.bg),
    force = sub(sample.specificForce, s.ba);
  const mid = integrate(s.q, rate, dt / 2),
    [dv, dp] = forceIntegrals(scale(rate, dt), force);
  s.p = add(
    s.p,
    add(scale(s.v, dt), scale(add(rotate(s.q, dp), [0, 0, G / 2]), dt * dt)),
  );
  s.v = add(s.v, scale(add(rotate(s.q, dv), [0, 0, G]), dt));
  s.q = integrate(s.q, rate, dt);
  const F = dynamicsJacobian(mid, force, rate), noise = new Float64Array(N);
  for (let i = 0; i < 3; i++) {
    noise[i + 3] = c.accelNoise ** 2;
    noise[i + 6] = c.gyroNoise ** 2;
    noise[i + 9] = c.accelBiasWalk ** 2;
    noise[i + 12] = c.gyroBiasWalk ** 2;
    noise[i + MAGNETIC_FIELD] = MAGNETIC_FIELD_WALK ** 2;
    noise[i + MAGNETIC_BIAS] = MAGNETIC_BIAS_WALK ** 2;
  }
  return propagateCovariance(s, F, noise, dt);
}

/** Shared second-order transition and matching PSD process-noise integral. */
export function propagateCovariance(s: NavState, F: Matrix, noise: Float64Array, dt: number): Matrix {
  const F2 = product(F, F, N, N, N), phi = identity(N);
  for (let i = 0; i < phi.length; i++) phi[i]! += F[i]! * dt + F2[i]! * dt * dt / 2;
  const P = sandwich(phi, s.P, N, N);
  // Integrate the SAME second-order transition used above. Three-point Gauss
  // quadrature is exact for this degree-four polynomial and forms a sum of
  // positive-semidefinite outer products, including bias→velocity→position noise.
  const column = new Float64Array(N);
  for (const [u, weight] of GAUSS3) {
    const tau = u * dt;
    for (let k = 0; k < N; k++) {
      if (!noise[k]!) continue;
      for (let i = 0; i < N; i++)
        column[i] =
          (i === k ? 1 : 0) +
          F[i * N + k]! * tau +
          (F2[i * N + k]! * tau * tau) / 2;
      for (let i = 0; i < N; i++) {
        if (!column[i]!) continue;
        for (let j = 0; j < N; j++)
          P[i * N + j]! += column[i]! * column[j]! * noise[k]! * dt * weight;
      }
    }
  }
  symmetrize(P, N);
  s.P = P;
  return phi;
}

/** Propagate a held IMU reading with bounded time/angle linearization steps. */
export function predictInterval(s: NavState, sample: ImuSample, dt: number, c: Required<AhrsOptions>, transition?: (phi: Matrix) => void): void {
  if (dt <= 0) return;
  const steps = Math.max(1, Math.ceil((dt - 1e-10) / .02), Math.ceil(norm(sub(sample.gyro, s.bg)) * dt / .05));
  for (let i = 0; i < steps; i++) {
    const phi = predict(s, sample, dt / steps, c);
    transition?.(phi);
  }
}
/** Joint update with χ²(0.999) innovation gating, Joseph covariance, and reset Jacobian. */
export function correct(
  s: NavState,
  residual: readonly number[],
  H: Matrix,
  variance: readonly number[],
  statistics: Statistics = s,
  observation?: { source: Observation['source']; time: number; publish: ObservationSink },
  restrictGain?: (gain: Matrix) => void,
  options: { priorWeight?: number; maxAttitudeCorrection?: number;
    /** Conditional spread of measurement hypotheses. The gain uses the original
     * observation noise; total covariance also includes K spread Kᵀ. */
    posteriorMeasurementSpread?: Matrix } = {},
): CorrectionResult {
  const m = residual.length,
    R = zeros(m);
  // Covariance intersection: unknown prior/measurement cross-correlation is
  // bounded by P/w and R/(1-w). Ordinary independent observations use w=1.
  const weight = options.priorWeight ?? 1;
  const prior = weight === 1 ? s.P : s.P.map(x => x / weight);
  for (let i = 0; i < m; i++) R[i * m + i] = variance[i]! / (weight === 1 ? 1 : 1 - weight);
  const PHt = product(prior, transpose(H, m, N), N, N, m),
    S = product(H, PHt, m, N, m);
  for (let i = 0; i < S.length; i++) S[i]! += R[i]!;
  statistics.nis = null;
  const gate = [0, 10.828, 13.816, 16.266][m]!;
  const finish = (result: CorrectionResult): CorrectionResult => {
    observation?.publish({ source: observation.source, time: observation.time, dimension: m,
      residual: [...residual], covariance: Array.from(S), nis: statistics.nis, gate, result,
      ...(weight === 1 ? {} : { priorWeight: weight }) });
    return result;
  };
  const L = cholesky(S, m);
  if (!L) {
    statistics.rejected++;
    statistics.reason = "Measurement covariance is not positive definite";
    return finish("covariance");
  }
  const solved = solve(L, residual, m),
    nis = residual.reduce((sum, x, i) => sum + x * solved[i]!, 0);
  statistics.nis = nis;
  if (!Number.isFinite(nis) || nis > gate) {
    statistics.rejected++;
    statistics.reason = "Measurement innovation rejected";
    return finish("innovation");
  }
  const K = zeros(N, m);
  for (let i = 0; i < N; i++)
    K.set(solve(L, PHt.subarray(i * m, (i + 1) * m), m), i * m);
  restrictGain?.(K);
  const dx = product(K, new Float64Array(residual), N, m, 1);
  // Large corrections exceed the local linearization, so ask for re-alignment.
  if (Math.hypot(dx[6]!, dx[7]!, dx[8]!) > (options.maxAttitudeCorrection ?? MAX_ATTITUDE_CORRECTION)) {
    statistics.rejected++;
    statistics.reason = "Attitude correction exceeds tracking range";
    return finish("attitude-limit");
  }
  if (
    Math.hypot(s.bg[0] + dx[12]!, s.bg[1] + dx[13]!, s.bg[2] + dx[14]!) >
      10 * RAD ||
    Math.hypot(s.ba[0] + dx[9]!, s.ba[1] + dx[10]!, s.ba[2] + dx[11]!) > 3
  ) {
    statistics.rejected++;
    statistics.reason = "Correction exceeds model limits — re-align";
    return finish("bias-limit");
  }
  const A = identity(N),
    KH = product(K, H, N, m, N);
  for (let i = 0; i < A.length; i++) A[i]! -= KH[i]!;
  const P = sandwich(A, prior, N, N),
    KRK = sandwich(K, R, N, m);
  for (let i = 0; i < P.length; i++) P[i]! += KRK[i]!;
  if (options.posteriorMeasurementSpread) {
    const spread = sandwich(K, options.posteriorMeasurementSpread, N, m);
    for (let i = 0; i < P.length; i++) P[i]! += spread[i]!;
  }
  s.p = add(s.p, [dx[0]!, dx[1]!, dx[2]!]);
  s.v = add(s.v, [dx[3]!, dx[4]!, dx[5]!]);
  s.velocityAnchor = add(s.velocityAnchor, [dx[VELOCITY_ANCHOR]!, dx[VELOCITY_ANCHOR + 1]!, dx[VELOCITY_ANCHOR + 2]!]);
  const delta: Vec3 = [dx[6]!, dx[7]!, dx[8]!];
  s.q = integrate(s.q, delta, 1);
  s.ba = add(s.ba, [dx[9]!, dx[10]!, dx[11]!]);
  s.bg = add(s.bg, [dx[12]!, dx[13]!, dx[14]!]);
  s.acceleration = add(s.acceleration, [dx[15]!, dx[16]!, dx[17]!]);
  s.magneticField = add(s.magneticField, [dx[18]!, dx[19]!, dx[20]!]);
  s.magneticBias = add(s.magneticBias, [dx[21]!, dx[22]!, dx[23]!]);
  s.transientAcceleration = add(s.transientAcceleration, [dx[24]!, dx[25]!, dx[26]!]);
  const reset = identity(N),
    J = rightJacobian(delta);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) reset[(i + 6) * N + j + 6] = J[i * 3 + j]!;
  s.P = sandwich(reset, P, N, N);
  symmetrize(s.P, N);
  statistics.accepted++;
  return finish("accepted");
}

function initializeComponent(
  s: NavState,
  index: number,
  variance: number,
): void {
  for (let i = 0; i < N; i++) s.P[index * N + i] = s.P[i * N + index] = 0;
  s.P[index * N + index] = variance;
}
export function gpsVelocity(fix: GpsFix): readonly number[] | null {
  return fix.velocityNed ?? (fix.speed !== null && (fix.track !== null || fix.speed === 0)
    ? [fix.speed * Math.cos((fix.track ?? 0) * RAD), fix.speed * Math.sin((fix.track ?? 0) * RAD)] : null);
}

export function fuseGps(
  s: NavState,
  fix: GpsFix,
  c: Required<AhrsOptions>,
  publish?: ObservationSink,
  northAligned = true,
): void {
  s.lastGpsTime = fix.time;
  s.velocityCorrection = null;
  const velocity = gpsVelocity(fix);
  if (velocity) {
    const axes = northAligned ? velocity.map((_, i) => i) : velocity.length === 3 ? [2] : [];
    // Initialize newly measured components once, then update already anchored
    // axes. Vertical velocity and altitude do not require a north reference.
    const initialized = axes.filter(i => i === 2 ? s.verticalVelocityInitialized || northAligned && s.velocityInitialized : s.velocityInitialized);
    const fresh = axes.filter(i => !initialized.includes(i));
    const variance = (i: number) => Math.max(.05, fix.velocityStd?.[i] ?? c.gpsVelocityStd) ** 2;
    if (fresh.length) {
      const v: [number, number, number] = [...s.v];
      for (const i of fresh) { v[i] = velocity[i]!; initializeComponent(s, i + 3, variance(i)); }
      s.v = v;
      if (fresh.includes(0)) s.velocityInitialized = true;
      if (fresh.includes(2)) s.verticalVelocityInitialized = true;
      s.accepted++;
      if (northAligned) { s.velocityCorrection = 'accepted'; s.lastVelocityFusion = fix.time; }
      if (fresh.includes(2)) s.lastVerticalVelocityFusion = fix.time;
      s.reason = 'GNSS velocity initialized';
      s.nis = null;
      publish?.({ source: 'velocity', time: fix.time, dimension: fresh.length, residual: [], covariance: null,
        nis: null, gate: null, result: 'initialized' });
    }
    if (initialized.length) {
      const H = zeros(initialized.length, N);
      initialized.forEach((axis, row) => { H[row * N + axis + 3] = 1; });
      const result = correct(s, initialized.map(i => velocity[i]! - s.v[i]!), H, initialized.map(variance), s,
        publish ? { source: 'velocity', time: fix.time, publish } : undefined);
      if (northAligned) s.velocityCorrection = result;
      if (result === 'accepted') {
        if (initialized.includes(0)) s.lastVelocityFusion = fix.time;
        if (initialized.includes(2)) { s.lastVerticalVelocityFusion = fix.time; s.verticalVelocityInitialized = true; }
        s.reason = 'GNSS velocity fused';
      }
    }
  }
  // Fuse altitude as position, never differentiate noisy altitude into a new sensor.
  if (
    fix.altitude !== null &&
    fix.altitudeAccuracy !== null &&
    fix.altitudeAccuracy <= 50
  ) {
    const variance = Math.max(2, fix.altitudeAccuracy / 1.96) ** 2;
    if (s.altitudeOrigin === null) {
      s.altitudeOrigin = fix.altitude + s.p[2];
      initializeComponent(s, 2, variance);
      s.altitude.accepted++;
      s.altitude.nis = null;
      s.altitude.reason = "GNSS altitude initialized";
      publish?.({ source: 'altitude', time: fix.time, dimension: 1, residual: [], covariance: null,
        nis: null, gate: null, result: 'initialized' });
    } else {
      const H = zeros(1, N);
      H[2] = 1;
      if (correct(s, [s.altitudeOrigin - fix.altitude - s.p[2]], H, [variance], s.altitude,
        publish ? { source: 'altitude', time: fix.time, publish } : undefined) === "accepted") {
        s.lastAltitudeFusion = fix.time;
        s.altitude.reason = "GNSS altitude fused";
      }
    }
  }
}
function attitudeCovariance(s: NavState): Matrix {
  const P = zeros(3);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) P[i * 3 + j] = s.P[(i + 6) * N + j + 6]!;
  return P;
}

export function angleStd(s: NavState): Vec3 {
  const J = eulerJacobian(s.q);
  // Euler roll/yaw are undefined at vertical pitch; do not report zero pitch
  // uncertainty from a symmetric finite difference across that singularity.
  if (!J) return [180, tiltStd(s), 180];
  const C = sandwich(J, attitudeCovariance(s), 3, 3);
  const std = (i: number) =>
    Math.min(180, Math.sqrt(Math.max(0, C[i * 3 + i]!)) / RAD);
  return [std(0), std(1), std(2)];
}

/** Largest 1σ angular uncertainty of the down direction, independent of yaw
 * and Euler coordinates. The two nonzero eigenvalues live in its tangent plane.
 */
export function tiltStd(s: NavState): number {
  const down = rotate(conjugate(s.q), [0, 0, 1]);
  const C = sandwich(skew(down), attitudeCovariance(s), 3, 3),
    trace = C[0]! + C[4]! + C[8]!,
    squaredTrace = C.reduce((sum, x) => sum + x * x, 0),
    largest =
      (trace + Math.sqrt(Math.max(0, 2 * squaredTrace - trace * trace))) / 2;
  return Math.min(180, Math.sqrt(Math.max(0, largest)) / RAD);
}

/** A supplied heading measures yaw only. Preserve tilt/bias uncertainty and
 * their correlations when restarting navigation around that new heading.
 */
export function transferAlignmentCovariance(
  previous: NavState,
  next: NavState,
  headingStd: number,
  correlated = false,
): void {
  const J = eulerJacobian(previous.q);
  if (!J) throw new RangeError("Heading is undefined at vertical pitch");
  transferYawCovariance(previous, next, J.subarray(6, 9), headingStd, correlated);
}

/** Change to an arbitrary local-level frame. Absolute yaw becomes unknown;
 * zero local yaw variance defines a gauge, NOT a new heading measurement.
 * This projection preserves down-direction/bias covariance even at vertical pitch. */
export function releaseHeadingCovariance(previous: NavState, next: NavState): void {
  transferYawCovariance(previous, next, rotate(conjugate(previous.q), [0, 0, 1]), 0);
}

function transferYawCovariance(previous: NavState, next: NavState, gradient: ArrayLike<number>, headingStd: number, correlated = false): void {
  // A frame change rotates world vectors together. Removing/replacing yaw also
  // transforms their errors; otherwise the magnetic anchor would fight alignment.
  const count = VELOCITY_ANCHOR - 6, down = rotate(conjugate(previous.q), [0, 0, 1]);
  const frameRotation = multiply(next.q, conjugate(previous.q)), frame = rotationMatrix(frameRotation);
  const transform = identity(count), gauge = new Float64Array(count);
  gauge.set(down, 0);
  gauge.set(cross([0, 0, 1], previous.acceleration), ACCELERATION - 6);
  gauge.set(cross([0, 0, 1], previous.transientAcceleration), TRANSIENT_ACCELERATION - 6);
  gauge.set(cross([0, 0, 1], previous.magneticField), MAGNETIC_FIELD - 6);
  for (let i = 0; i < count; i++) for (let j = 0; j < 3; j++)
    transform[i * count + j]! -= gauge[i]! * gradient[j]!;
  const frameTransform = identity(count);
  for (const offset of [ACCELERATION - 6, MAGNETIC_FIELD - 6, TRANSIENT_ACCELERATION - 6])
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
      frameTransform[(offset + i) * count + offset + j] = frame[i * 3 + j]!;
  const prior = zeros(count);
  for (let i = 0; i < count; i++) for (let j = 0; j < count; j++)
    prior[i * count + j] = previous.P[(i + 6) * N + j + 6]!;
  const covariance = sandwich(transform, prior, count, count);
  for (let i = 0; i < count; i++) for (let j = 0; j < count; j++)
    covariance[i * count + j]! += (headingStd * RAD) ** 2 * gauge[i]! * gauge[j]!;
  // A motion-fit heading shares IMU/seed errors with this estimator. Until its
  // cross-covariance with the corrected main filter is known, bound both terms
  // and their unknown cross terms by 2(A P Aᵀ + variance u uᵀ).
  if (correlated) for (let i = 0; i < covariance.length; i++) covariance[i]! *= 2;
  const rotated = sandwich(frameTransform, covariance, count, count);
  for (let i = 0; i < count; i++) for (let j = 0; j < count; j++)
    next.P[(i + 6) * N + j + 6] = rotated[i * count + j]!;
  next.acceleration = rotate(frameRotation, previous.acceleration);
  next.transientAcceleration = rotate(frameRotation, previous.transientAcceleration);
  next.magneticField = rotate(frameRotation, previous.magneticField);
  next.magnetic.innovationMean = rotate(frameRotation, previous.magnetic.innovationMean);
  next.magnetic.rotationMean = product(frame, previous.magnetic.rotationMean, 3, 3, 3);
  for (const candidate of [next.magnetic.candidate, next.magnetic.recoveryCandidate])
    if (candidate) candidate.world = rotate(frameRotation, candidate.world);
}
/** Numerical integrity is separate from the validity of an unaided trajectory. */
export function numericallyHealthy(s: NavState): boolean {
  return (
    s.P.every(Number.isFinite) &&
    [...s.p, ...s.v, ...s.velocityAnchor, ...s.q, ...s.bg, ...s.ba, ...s.acceleration, ...s.transientAcceleration,
      ...s.accelerationRate, ...s.magneticField, ...s.magneticBias].every(Number.isFinite) &&
    Math.abs(Math.hypot(...s.q) - 1) < 1e-6 &&
    covarianceHealthy(s.P)
  );
}

/** Gauge-fixed local yaw can have exactly zero variance. Check semidefiniteness
 * with roundoff-scale diagonal regularization; never inject this into the filter. */
function covarianceHealthy(P: Matrix): boolean {
  const checked = P.slice();
  for (let i = 0; i < N; i++) checked[i * N + i]! += Math.max(1e-18, Math.abs(P[i * N + i]!) * 1e-12);
  return cholesky(checked, N) !== null;
}
