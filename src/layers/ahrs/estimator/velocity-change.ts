import { correct, gpsVelocity, type NavState, type ObservationSink } from './eskf.js';
import { cholesky, identity, sandwich, solve, zeros } from './linalg.js';
import { N, VELOCITY_ANCHOR } from './state-layout.js';
import type { AhrsOptions, GpsFix } from './types.js';

function discardAnchor(s: NavState): void {
  s.gpsAnchor = null;
  s.velocityAnchor = [0, 0, 0];
  // Marginalize the clone, leaving the retained state's covariance unchanged.
  for (let i = VELOCITY_ANCHOR; i < N; i++)
    for (let j = 0; j < N; j++) s.P[i * N + j] = s.P[j * N + i] = 0;
}

/** GPS velocity-change magnitude is invariant to the unknown rotation to north.
 * A stochastic clone keeps the error shared by the two inertial endpoints.
 * Disjoint GPS pairs avoid counting an endpoint's receiver noise twice.
 * See velocity-change.md for the radial likelihood and mixture covariance.
 */
export function fuseVelocityChange(s: NavState, fix: GpsFix, c: Required<AhrsOptions>, publish?: ObservationSink): void {
  const velocity = gpsVelocity(fix);
  if (!velocity) return;
  const variance = Math.max(.05, fix.velocityStd?.[0] ?? c.gpsVelocityStd,
    fix.velocityStd?.[1] ?? c.gpsVelocityStd) ** 2;
  if (s.gpsAnchor && fix.time - s.gpsAnchor.time > 15) discardAnchor(s);
  if (!s.gpsAnchor) {
    s.gpsAnchor = { time: fix.time, velocity: [velocity[0]!, velocity[1]!], variance };
    s.velocityAnchor = [...s.v];
    const T = identity(N);
    for (let i = 0; i < 3; i++) {
      T.fill(0, (VELOCITY_ANCHOR + i) * N, (VELOCITY_ANCHOR + i + 1) * N);
      T[(VELOCITY_ANCHOR + i) * N + 3 + i] = 1;
    }
    s.P = sandwich(T, s.P, N, N);
    return;
  }
  if (fix.time - s.gpsAnchor.time < 2 - 1e-9) return;
  const anchor = s.gpsAnchor;
  const radius = Math.hypot(velocity[0]! - anchor.velocity[0], velocity[1]! - anchor.velocity[1]);
  const noise = variance + anchor.variance;
  // This factor aids near-steady intervals. Substantial maneuvers belong to the
  // independent heading fit, then full vector GPS once north is observable.
  if (radius > 3 * Math.sqrt(noise)) { discardAnchor(s); return; }
  const delta = [s.v[0] - s.velocityAnchor[0], s.v[1] - s.velocityAnchor[1]];
  const H = zeros(2, N);
  for (let i = 0; i < 2; i++) { H[i * N + 3 + i] = 1; H[i * N + VELOCITY_ANCHOR + i] = -1; }
  const S = sandwich(H, s.P, 2, N);
  S[0]! += noise; S[3]! += noise;
  const L = cholesky(S, 2);
  if (!L) { discardAnchor(s); return; }
  const hypotheses = Array.from({ length: 64 }, (_, index) => {
    const angle = index * 2 * Math.PI / 64;
    const value = [radius * Math.cos(angle), radius * Math.sin(angle)];
    const residual = value.map((x, i) => x - delta[i]!);
    const solved = solve(L, residual, 2);
    return { value, nis: residual.reduce((sum, x, i) => sum + x * solved[i]!, 0) };
  });
  const minimum = Math.min(...hypotheses.map(h => h.nis));
  if (!Number.isFinite(minimum) || minimum > 13.816) {
    s.rejected++; s.nis = minimum; s.velocityCorrection = 'innovation';
    s.reason = 'GNSS velocity-change innovation rejected';
    const nearest = hypotheses.reduce((a, b) => a.nis < b.nis ? a : b);
    publish?.({ source: 'velocity-change', time: fix.time, dimension: 2, residual: nearest.value.map((x, i) => x - delta[i]!),
      covariance: Array.from(S), nis: minimum, gate: 13.816, result: 'innovation' });
    discardAnchor(s); return;
  }
  const weights = hypotheses.map(h => Math.exp(-.5 * (h.nis - minimum)));
  const total = weights.reduce((a, b) => a + b, 0), mean = [0, 0], spread = zeros(2);
  for (let k = 0; k < hypotheses.length; k++) for (let i = 0; i < 2; i++)
    mean[i]! += weights[k]! / total * hypotheses[k]!.value[i]!;
  for (let k = 0; k < hypotheses.length; k++) for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++)
    spread[i * 2 + j]! += weights[k]! / total * (hypotheses[k]!.value[i]! - mean[i]!) * (hypotheses[k]!.value[j]! - mean[j]!);
  s.velocityCorrection = correct(s, mean.map((x, i) => x - delta[i]!), H, [noise, noise], s,
    publish ? { source: 'velocity-change', time: fix.time, publish } : undefined, undefined,
    { posteriorMeasurementSpread: spread });
  if (s.velocityCorrection === 'accepted') {
    s.lastVelocityFusion = fix.time;
    s.reason = 'GNSS velocity-change magnitude fused in the local frame';
  }
  discardAnchor(s);
}
