import { N } from '../src/layers/ahrs/estimator/state-layout';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS } from '../src/layers/ahrs/estimator/ahrs';
import { dynamicsJacobian, fuseGps, initialState, predict } from '../src/layers/ahrs/estimator/eskf';
import { cholesky, solve } from '../src/layers/ahrs/estimator/linalg';
import { G, RAD, fromEuler, rightJacobian, type Vec3 } from '../src/layers/ahrs/estimator/math';

// Independent SO(3) reference: ordinary matrices and Rodrigues' formula, no
// production quaternion multiplication, integration or reset implementation.
const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const multiply = (a: number[], b: number[]) => I.map((_, k) =>
  [0, 1, 2].reduce((sum, j) => sum + a[Math.floor(k / 3) * 3 + j]! * b[j * 3 + k % 3]!, 0));
const transpose = (a: number[]) => I.map((_, k) => a[k % 3 * 3 + Math.floor(k / 3)]!);
const apply = (a: number[], v: readonly number[]) => [0, 1, 2].map(i =>
  v.reduce((sum, x, j) => sum + a[i * 3 + j]! * x, 0));
function exp(v: readonly number[]) {
  const t = Math.hypot(...v), [x, y, z] = v;
  if (t === 0) return [...I];
  const W = [0, -z!, y!, z!, 0, -x!, -y!, x!, 0], W2 = multiply(W, W);
  return I.map((x, i) => x + Math.sin(t) / t * W[i]! + 2 * (Math.sin(t / 2) / t) ** 2 * W2[i]!);
}
function log(R: number[]) {
  const v = [(R[7]! - R[5]!) / 2, (R[2]! - R[6]!) / 2, (R[3]! - R[1]!) / 2];
  const sine = Math.hypot(...v), cosine = (R[0]! + R[4]! + R[8]! - 1) / 2;
  return v.map(x => x * (sine < 1e-12 ? 1 : Math.atan2(sine, cosine) / sine));
}

test('navigation ESKF dynamics columns match independent finite differences', () => {
  const dt = 1e-5, epsilon = 1e-5;
  for (const angles of [[0, 0, 0], [.6, -.7, 2.4], [-1.2, 1.5, -2]]) {
    const [roll, pitch, yaw] = angles as [number, number, number];
    const R = multiply(multiply(exp([0, 0, yaw]), exp([0, pitch, 0])), exp([roll, 0, 0]));
    const force: Vec3 = [1.2, -2.5, -8.8], rate: Vec3 = [.2, -.4, .7];
    const F = dynamicsJacobian(fromEuler(roll, pitch, yaw), force, rate);
    const reference = multiply(R, exp(rate.map(x => x * dt))), acceleration = apply(R, force);
    const evolve = (error: number[]) => {
      const trueR = multiply(R, exp(error.slice(6, 9)));
      const trueAcceleration = apply(trueR, force.map((x, i) => x - error[i + 9]!));
      const nextR = multiply(trueR, exp(rate.map((x, i) => (x - error[i + 12]!) * dt)));
      return [
        ...error.slice(0, 3).map((x, i) => x + error[i + 3]! * dt),
        ...error.slice(3, 6).map((x, i) => x + (trueAcceleration[i]! - acceleration[i]!) * dt),
        ...log(multiply(transpose(reference), nextR)), ...error.slice(9),
      ];
    };
    for (let col = 0; col < 15; col++) {
      const positive = Array<number>(15).fill(0), negative = [...positive];
      positive[col] = epsilon; negative[col] = -epsilon;
      const plus = evolve(positive), minus = evolve(negative);
      for (let row = 0; row < 15; row++) {
        const numerical = ((plus[row]! - minus[row]!) / (2 * epsilon) - (row === col ? 1 : 0)) / dt;
        assert.ok(Math.abs(numerical - F[row * N + col]!) < 2e-4, `F[${row},${col}]: ${numerical} vs ${F[row * N + col]}`);
      }
    }
  }
});

test('covariance reset Jacobian matches an independent rotation composition near zero and at large corrections', () => {
  for (const delta of [[1e-8, -2e-8, 3e-8], [.15, -.25, .35], [-1, .7, .3]] as Vec3[]) {
    const J = rightJacobian(delta), epsilon = 1e-6;
    for (let col = 0; col < 3; col++) {
      const plus = delta.map((x, i) => x + (i === col ? epsilon : 0));
      const minus = delta.map((x, i) => x - (i === col ? epsilon : 0));
      const a = log(multiply(exp(delta.map(x => -x)), exp(plus)));
      const b = log(multiply(exp(delta.map(x => -x)), exp(minus)));
      for (let row = 0; row < 3; row++) assert.ok(Math.abs((a[row]! - b[row]!) / (2 * epsilon) - J[row * 3 + col]!) < 1e-8);
    }
  }
});

test('seeded Monte Carlo checks navigation marginal NEES and pre-gate GPS NIS against modeled noise', t => {
  let seed = 0x53a1;
  const uniform = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed + .5) / 4294967296; };
  const gaussian = () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
  const c = { ...DEFAULTS, initialTiltStd: 1, initialHeadingStd: 2 }, trials = 128, dt = .01;
  let nees = 0, nis = 0, measurements = 0, rejections = 0;
  for (let trial = 0; trial < trials; trial++) {
    const e = [gaussian() * RAD, gaussian() * RAD, gaussian() * 2 * RAD];
    const angle = Math.hypot(...e), factor = Math.sin(angle / 2) / angle;
    const s = initialState([Math.cos(angle / 2), e[0]! * factor, e[1]! * factor, e[2]! * factor], [0, 0, 0], [0, 0, 0], true, c);
    s.p = [gaussian() * 100, gaussian() * 100, gaussian() * 100];
    s.v = [50 + gaussian() * 20, gaussian() * 20, gaussian() * 20];
    s.velocityInitialized = true; s.verticalVelocityInitialized = true;
    const ba = [0, 1, 2].map(() => gaussian() * c.initialAccelBiasStd);
    const bg = [0, 1, 2].map(() => gaussian() * c.initialGyroBiasStd);
    for (let step = 1; step <= 100; step++) {
      const gyro = bg.map(x => x + gaussian() * c.gyroNoise / Math.sqrt(dt)) as unknown as Vec3;
      const force = ba.map((x, i) => x + (i === 2 ? -G : 0) + gaussian() * c.accelNoise / Math.sqrt(dt)) as unknown as Vec3;
      predict(s, { time: step * dt, gyro, specificForce: force }, dt, c);
      for (let i = 0; i < 3; i++) {
        ba[i]! += gaussian() * c.accelBiasWalk * Math.sqrt(dt);
        bg[i]! += gaussian() * c.gyroBiasWalk * Math.sqrt(dt);
      }
      if (step % 20 === 0) fuseGps(s, { time: step * dt, speed: null, track: null, accuracy: 3,
        altitude: null, altitudeAccuracy: null,
        velocityNed: [50 + gaussian() * c.gpsVelocityStd, gaussian() * c.gpsVelocityStd, gaussian() * c.gpsVelocityStd],
      }, c, observation => {
        nis += observation.nis!; measurements++;
        if (observation.result !== 'accepted') rejections++;
      });
    }
    const a = 2 * Math.atan2(Math.hypot(s.q[1], s.q[2], s.q[3]), s.q[0]);
    const f = a / (Math.hypot(s.q[1], s.q[2], s.q[3]) || 1);
    const error = [50 - s.p[0], -s.p[1], -s.p[2], 50 - s.v[0], -s.v[1], -s.v[2],
      -s.q[1] * f, -s.q[2] * f, -s.q[3] * f, ...ba.map((x, i) => x - s.ba[i]!), ...bg.map((x, i) => x - s.bg[i]!)];
    const marginal = new Float64Array(15 * 15);
    for (let i = 0; i < 15; i++) for (let j = 0; j < 15; j++) marginal[i * 15 + j] = s.P[i * N + j]!;
    const L = cholesky(marginal, 15);
    assert.ok(L, 'full covariance must remain positive definite');
    const weighted = solve(L, error, 15);
    nees += error.reduce((sum, x, i) => sum + x * weighted[i]!, 0);
  }
  const normalizedNees = nees / (15 * trials), normalizedNis = nis / (3 * measurements);
  t.diagnostic(JSON.stringify({ trials, measurements, normalizedNees, normalizedNis, rejections }));
  // Broad finite-ensemble bounds; these detect scaling/consistency defects without
  // claiming universal consistency or fitting sensor noise to one realization.
  assert.ok(normalizedNees > .75 && normalizedNees < 1.25);
  assert.ok(normalizedNis > .75 && normalizedNis < 1.25);
  assert.ok(rejections < 6);
});
