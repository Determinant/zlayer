import { covarianceIsPsd } from './helpers/ahrs-motion';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Ahrs, DEFAULTS } from '../src/layers/ahrs/estimator/ahrs';
import { cloneState, initialState, predictInterval, restartNavigation, transferAlignmentCovariance, type NavState } from '../src/layers/ahrs/estimator/eskf';
import { compassModel, fuseMagnetic, magneticModel } from '../src/layers/ahrs/estimator/magnetic-fusion';
import { gravityModel } from '../src/layers/ahrs/estimator/gravity-aiding';
import { ACCELERATION, TRANSIENT_ACCELERATION, MAGNETIC_FIELD, MAGNETIC_BIAS, N } from '../src/layers/ahrs/estimator/state-layout';
import { G, RAD, fromEuler, integrate, toEuler, unit } from '../src/layers/ahrs/estimator/math';
import type { MagneticSample, Observation } from '../src/layers/ahrs/estimator/types';

// Qualify a datum ending at sample.time; later checks exercise an established reference.
function qualify(s: NavState, sample: MagneticSample): void {
  for (let i = 0; i <= 4; i++) fuseMagnetic(s, { ...sample, time: sample.time - 2 + i / 2 }, DEFAULTS);
  assert.equal(s.magneticReference?.source, sample.source);
}

for (const model of [gravityModel, magneticModel]) test(`${model.name} Jacobian covers every error-state column`, () => {
  const state = initialState(fromEuler(.3, -.5, 1.7), [.001, -.002, .003], [.1, .2, -.1], true, DEFAULTS);
  state.acceleration = [1.2, -.7, .4]; state.magneticField = [.4, -.3, .7]; state.magneticBias = [.03, -.02, .01];
  const analytic = model(state).H, epsilon = 1e-6;
  for (let col = 0; col < N; col++) {
    const evaluate = (sign: number) => {
      const s = cloneState(state), delta = [0, 0, 0] as [number, number, number];
      if (col >= 6 && col < 9) { delta[col - 6] = sign * epsilon; s.q = integrate(s.q, delta, 1); }
      for (const [offset, key] of [[9, 'ba'], [12, 'bg'], [ACCELERATION, 'acceleration'],
        [MAGNETIC_FIELD, 'magneticField'], [MAGNETIC_BIAS, 'magneticBias'], [TRANSIENT_ACCELERATION, 'transientAcceleration']] as const) {
        if (col >= offset && col < offset + 3) {
          const v = [...s[key]] as [number, number, number]; v[col - offset]! += sign * epsilon; s[key] = v;
        }
      }
      return model(s).expected;
    };
    const plus = evaluate(1), minus = evaluate(-1);
    for (let row = 0; row < 3; row++) assert.ok(Math.abs((plus[row]! - minus[row]!) / (2 * epsilon) - analytic[row * N + col]!) < 1e-7);
  }
});

test('a magnetic anchor preserves attitude uncertainty and cannot manufacture north', () => {
  const s = initialState(fromEuler(.2, -.1, 1), [0, 0, 0], [0, 0, 0], true, DEFAULTS), before = cloneState(s);
  for (let i = 0; i < 50; i++) fuseMagnetic(s, { time: i / 5, source: 'magnetometer', vector: [25, 10, 35] }, DEFAULTS);
  s.q.forEach((value, i) => assert.ok(Math.abs(value - before.q[i]!) < 1e-12));
  for (let i = 6; i < 15; i++) for (let j = 6; j < 15; j++)
    assert.ok(Math.abs(s.P[i * N + j]! - before.P[i * N + j]!) < 1e-12);
  assert.ok(covarianceIsPsd(s.P, N));
});

test('heading alignment rotates the field, acceleration and their joint gauge covariance', () => {
  const s = initialState(fromEuler(.2, -.1, .4), [0, 0, 0], [0, 0, 0], true, DEFAULTS);
  s.acceleration = [1, 2, .3];
  qualify(s, { time: 0, source: 'magnetometer', vector: [25, 10, 35] });
  const next = restartNavigation(s, fromEuler(.2, -.1, 2), DEFAULTS);
  transferAlignmentCovariance(s, next, 8);
  for (const model of [gravityModel, magneticModel]) {
    const a = model(s), b = model(next);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(a.expected[i]! - b.expected[i]!) < 1e-12);
    // Replacing absolute heading must preserve the uncertainty of relative sensors.
    const projected = (H: Float64Array, P: Float64Array, row: number, col: number) => {
      let value = 0;
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) value += H[row * N + i]! * P[i * N + j]! * H[col * N + j]!;
      return value;
    };
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
      assert.ok(Math.abs(projected(a.H, s.P, i, j) - projected(b.H, next.P, i, j)) < 1e-10);
  }
});

function flight(source: MagneticSample['source'], delay = 0) {
  const filter = new Ahrs(), pending: MagneticSample[] = [];
  filter.setGyroBias([0, 0, 0], .2 * RAD);
  for (let i = 0; i <= 120 * 20; i++) {
    const time = i / 20;
    filter.update({ time, gyro: [.06 * RAD, -.08 * RAD, .15 * RAD], specificForce: [0, 0, -G] });
    // Stop new magnetic measurements before the end, allowing both receipt
    // schedules to consume precisely the same measurement set.
    if (i % 10 === 0 && time <= 118) pending.push(source === 'webkit-compass'
      ? { time, source, heading: 243, accuracy: 3, axis: [1, 0, 0] }
      : { time, source, vector: source === 'magnetometer' ? [-25, 10, 35] : [-.8, .6, 0] });
    while (pending.length && pending[0]!.time <= time - delay + 1e-8) filter.updateMagnetic(pending.shift()!);
  }
  return filter;
}
for (const source of ['magnetometer', 'absolute-orientation', 'webkit-compass'] as const)
  test(`${source} constrains drift without GPS or an absolute north assignment`, () => {
    const filter = flight(source), state = filter.getState(120);
    assert.ok(state.magneticFusion.accepted > (source === 'magnetometer' ? 100 : 0), 'correlated fallbacks may decline redundant observations');
    assert.ok(Math.abs(Math.atan2(Math.sin(state.yaw * RAD), Math.cos(state.yaw * RAD)) / RAD) < 5);
    assert.ok(Math.abs(state.roll) < 3 && Math.abs(state.pitch) < 3);
    assert.ok(state.tiltStd < 10);
    assert.equal(state.headingReference, 'relative');
    assert.equal(state.attitudeStd[2], Infinity);
    assert.ok(Number.isFinite(state.relativeYawStd));
    assert.ok(covarianceIsPsd(filter.getCovariance(), N));
  });

test('delayed magnetic readings reproduce acquisition-time fusion', () => {
  const a = flight('magnetometer'), b = flight('magnetometer', .4);
  const before = a.getState(120), after = b.getState(120);
  assert.equal(before.magneticFusion.accepted, after.magneticFusion.accepted);
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(before.quaternion[i]! - after.quaternion[i]!) < 1e-10);
  a.getCovariance().forEach((value, i) => assert.ok(Math.abs(value - b.getCovariance()[i]!) < 1e-9));
});

test('a near-vertical raw field still corrects tilt, while a scalar vertical compass axis is rejected', () => {
  const s = initialState([1, 0, 0, 0], [0, 0, 0], [0, 0, 0], true, DEFAULTS);
  qualify(s, { time: 0, source: 'magnetometer', vector: [0, 0, 40] });
  predictInterval(s, { time: 0, gyro: [.1, 0, 0], specificForce: [0, 0, -G] }, .2, DEFAULTS);
  const before = s.q[1];
  for (let i = 1; i <= 12; i++) {
    s.tilt.lastFusion = i / 5;
    fuseMagnetic(s, { time: i / 5, source: 'magnetometer', vector: [0, 0, 40] }, DEFAULTS);
  }
  assert.ok(s.q[1] < before);
  fuseMagnetic(s, { time: 5, source: 'webkit-compass', heading: 0, accuracy: 3, axis: [0, 0, 1] }, DEFAULTS);
  assert.equal(s.magnetic.rejected, 1);
});

test('strength disturbances are rejected without replacing the anchor; valid evidence recovers', () => {
  const s = initialState([1, 0, 0, 0], [0, 0, 0], [0, 0, 0], true, DEFAULTS);
  qualify(s, { time: 0, source: 'magnetometer', vector: [25, 0, 35] });
  const anchor = [...s.magneticField];
  fuseMagnetic(s, { time: .2, source: 'magnetometer', vector: [45, 0, 60] }, DEFAULTS);
  assert.equal(s.magnetic.accepted, 0); assert.equal(s.magnetic.rejected, 1);
  assert.deepEqual(s.magneticField, anchor);
  fuseMagnetic(s, { time: 3, source: 'magnetometer', vector: [25, 0, 35] }, DEFAULTS);
  assert.equal(s.magnetic.accepted, 0, 'a holdoff alone does not requalify the sensor');
  for (let i = 1; i <= 10; i++) fuseMagnetic(s, { time: 3 + i / 5, source: 'magnetometer', vector: [25, 0, 35] }, DEFAULTS);
  assert.equal(s.magnetic.accepted, 0, 'magnetic consistency cannot replace fresh tilt evidence during reacquisition');
  assert.equal(s.magnetic.reason, 'Waiting for qualified tilt before magnetic reacquisition');
  s.tilt.lastFusion = 5.2;
  fuseMagnetic(s, { time: 5.2, source: 'magnetometer', vector: [25, 0, 35] }, DEFAULTS);
  assert.equal(s.magnetic.accepted, 1);
});

for (const source of ['absolute-orientation', 'webkit-compass'] as const) for (const tiltQualified of [false, true])
  test(`${source} reacquires a missed ninety-degree yaw only with qualified tilt, qualified=${tiltQualified}`, () => {
    const state = initialState([1, 0, 0, 0], [0, 0, 0], [0, 0, 0], false, DEFAULTS);
    const sample = (time: number, heading: number): MagneticSample => source === 'webkit-compass'
      ? { time, source, heading, accuracy: 5, axis: [1, 0, 0] }
      : { time, source, vector: [Math.cos(heading * RAD), -Math.sin(heading * RAD), 0] };
    qualify(state, sample(0, 0));
    // Isolate yaw recovery after tilt has (or has not) independently recovered.
    state.P[8 * N + 8]! += (90 * RAD) ** 2;
    if (!tiltQualified) for (const axis of [6, 7]) state.P[axis * N + axis] = (20 * RAD) ** 2;
    state.magnetic.reacquiring = true;
    state.magnetic.healthySince = Infinity;
    const observations: Observation[] = [];
    for (let i = 1; i <= 8; i++) {
      state.tilt.lastFusion = i / 2;
      fuseMagnetic(state, sample(i / 2, 90), DEFAULTS, observation => observations.push(observation));
    }
    const attitude = toEuler(state.q);
    assert.ok(Math.abs(attitude.roll) < 1e-12 && Math.abs(attitude.pitch) < 1e-12, 'heading-only mean correction preserves tilt');
    if (tiltQualified) {
      assert.ok(Math.abs(attitude.yaw / RAD - 90) < 5);
      assert.equal(state.magnetic.reacquiring, false);
      const recovery = observations.find(observation => observation.result === 'accepted' && observation.iterations);
      assert.ok(recovery && recovery.priorWeight! < 1, 'recovery keeps the unknown-correlation bound');
      assert.equal(state.magnetic.accepted, observations.filter(observation => observation.result === 'accepted').length,
        'iteration and weight candidates are not counted as repeated observations');
    } else {
      assert.equal(state.magnetic.accepted, 0);
      assert.equal(attitude.yaw, 0);
      assert.equal(state.magnetic.reacquiring, true);
    }
  });

for (const source of ['absolute-orientation', 'webkit-compass'] as const)
  test(`${source} rejects a field jump before CI can inflate its innovation allowance`, () => {
    const state = initialState([1, 0, 0, 0], [0, 0, 0], [0, 0, 0], false, DEFAULTS);
    const sample = (time: number, heading: number): MagneticSample => source === 'webkit-compass'
      ? { time, source, heading, accuracy: 5, axis: [1, 0, 0] }
      : { time, source, vector: [Math.cos(heading * RAD), -Math.sin(heading * RAD), 0] };
    qualify(state, sample(0, 0));
    state.P[8 * N + 8]! += (15 * RAD) ** 2;
    state.tilt.lastFusion = .5;
    const before = cloneState(state);
    fuseMagnetic(state, sample(.5, 90), DEFAULTS);
    assert.equal(state.magnetic.accepted, 0);
    assert.equal(state.magnetic.rejected, 1);
    assert.equal(state.magnetic.reason, 'Measurement innovation rejected');
    assert.deepEqual(state.q, before.q);
    assert.deepEqual(state.P, before.P);
  });

test('source switching seeds without snapping attitude; duplicates and permission loss do not fuse', () => {
  const filter = flight('magnetometer'), before = filter.getState(120);
  filter.updateMagnetic({ time: 120, source: 'webkit-compass', heading: 10, accuracy: 3, axis: [1, 0, 0] });
  assert.deepEqual(filter.getState(120).quaternion, before.quaternion);
  assert.equal(filter.getState(120).magneticFusion.active, false);
  filter.updateMagnetic({ time: 120, source: 'webkit-compass', heading: 150, accuracy: 3, axis: [1, 0, 0] });
  assert.deepEqual(filter.getState(120).quaternion, before.quaternion);
  filter.magneticUnavailable('Permission revoked');
  assert.match(filter.getState(120).magneticFusion.reason, /Permission/);
  assert.equal(filter.getState(120).magneticFusion.active, false);
});

for (const source of ['absolute-orientation', 'webkit-compass'] as const)
  test(`${source} scalar Jacobian includes body-axis projection and reference uncertainty`, () => {
    const s = initialState(fromEuler(.4, -.3, 1.1), [0, 0, 0], [0, 0, 0], true, DEFAULTS);
    s.magneticField = [.6, -.3, .2];
    const axis = unit([1, .2, .4]), epsilon = 1e-6;
    const sample = source === 'absolute-orientation' ? { time: 1, source, vector: axis }
      : { time: 1, source, heading: 30, accuracy: 4, axis };
    const analytic = compassModel(s, sample).H;
    for (const col of [6, 7, 8, 18, 19, 20]) {
      const residual = (sign: number) => {
        const perturbed = cloneState(s), delta: [number, number, number] = [0, 0, 0];
        if (col < 9) { delta[col - 6] = sign * epsilon; perturbed.q = integrate(s.q, delta, 1); }
        else { const field = [...s.magneticField] as [number, number, number]; field[col - 18]! += sign * epsilon; perturbed.magneticField = field; }
        return compassModel(perturbed, sample).residual[0]!;
      };
      assert.ok(Math.abs(-(residual(1) - residual(-1)) / (2 * epsilon) - analytic[col]!) < 1e-7);
    }
  });

for (const first of [[45, 0, 60], [-25, 0, 35]] as const)
  test(`a disturbed provisional magnetic reading ${first} cannot poison startup`, () => {
    const state = initialState([1, 0, 0, 0], [0, 0, 0], [0, 0, 0], false, DEFAULTS);
    const prior = state.P.slice();
    fuseMagnetic(state, { time: 0, source: 'magnetometer', vector: first }, DEFAULTS);
    for (let i = 1; i <= 4; i++) {
      fuseMagnetic(state, { time: i / 2, source: 'magnetometer', vector: [25, 0, 35] }, DEFAULTS);
      assert.equal(state.magneticReference, null);
      assert.deepEqual(state.P, prior, 'qualification must not alter live covariance');
    }
    fuseMagnetic(state, { time: 2.5, source: 'magnetometer', vector: [25, 0, 35] }, DEFAULTS);
    assert.equal(state.magneticReference?.scale, Math.hypot(25, 35));
    fuseMagnetic(state, { time: 3, source: 'magnetometer', vector: [25, 0, 35] }, DEFAULTS);
    assert.equal(state.magnetic.accepted, 1);
  });

test('provider changes preserve attitude/bias marginals and retain initial OS error in relative observations', () => {
  const state = initialState(fromEuler(.2, -.1, .5), [0, 0, 0], [0, 0, 0], true, DEFAULTS);
  const before = cloneState(state);
  for (let cycle = 0; cycle < 5; cycle++) {
    qualify(state, { time: cycle * 10, source: 'magnetometer', vector: [25, 0, 35] });
    qualify(state, { time: cycle * 10 + 5, source: 'webkit-compass', axis: [1, 0, 0], heading: 130, accuracy: 12 });
    assert.deepEqual(state.q, before.q);
    for (let i = 6; i < 18; i++) for (let j = 6; j < 18; j++)
      assert.ok(Math.abs(state.P[i * N + j]! - before.P[i * N + j]!) < 1e-14,
        'reference changes preserve the retained marginal within floating-point roundoff');
    const observation = compassModel(state, { time: cycle * 10 + 6, source: 'webkit-compass', axis: [1, 0, 0], heading: 130, accuracy: 5 });
    assert.ok(Math.abs(observation.variance[0]! - 2 * ((12 * RAD) ** 2 + (5 * RAD) ** 2)) < 1e-12);
    assert.ok(covarianceIsPsd(state.P, N));
  }
});

for (const yawStd of [5, 90]) test(`magnetic-only outage permits qualified recovery with the actual ${yawStd} degree prior`, () => {
  const state = initialState([1, 0, 0, 0], [0, 0, 0], [0, 0, 0], false, DEFAULTS);
  qualify(state, { time: 0, source: 'magnetometer', vector: [25, 0, 35] });
  state.q = fromEuler(0, 0, Math.PI / 2);
  state.P[8 * N + 8]! += (yawStd * RAD) ** 2;
  const observations: Observation[] = [];
  for (let i = 0; i <= 20; i++) {
    const time = 5 + i / 10;
    state.tilt.lastFusion = time;
    fuseMagnetic(state, { time, source: 'magnetometer', vector: [25, 0, 35] }, DEFAULTS, x => observations.push(x));
  }
  if (yawStd === 90) {
    assert.ok(Math.abs(toEuler(state.q).yaw / RAD) < 5);
    assert.ok(observations.some(x => x.result === 'accepted' && x.iterations));
  } else {
    assert.equal(state.magnetic.accepted, 0, 'an outage does not license overriding a tight prior with a conflicting field');
    assert.ok(Math.abs(toEuler(state.q).yaw - Math.PI / 2) < 1e-12);
  }
  assert.ok(covarianceIsPsd(state.P, N));
});

test('an unstable returning field cannot qualify merely by keeping its strength and inclination', () => {
  const state = initialState([1, 0, 0, 0], [0, 0, 0], [0, 0, 0], false, DEFAULTS);
  qualify(state, { time: 0, source: 'magnetometer', vector: [25, 0, 35] });
  const reference = [...state.magneticField];
  state.q = fromEuler(0, 0, Math.PI / 2);
  state.P[8 * N + 8]! += (90 * RAD) ** 2;
  for (let i = 0; i <= 30; i++) {
    const time = 5 + i / 10, angle = (i % 2 ? 20 : -20) * RAD;
    state.tilt.lastFusion = time;
    fuseMagnetic(state, { time, source: 'magnetometer', vector: [25 * Math.cos(angle), 25 * Math.sin(angle), 35] }, DEFAULTS);
  }
  assert.equal(state.magnetic.accepted, 0);
  assert.deepEqual(state.magneticField, reference);
  assert.equal(state.magnetic.reacquiring, true);
});
