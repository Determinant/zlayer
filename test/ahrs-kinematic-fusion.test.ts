import assert from 'node:assert/strict';
import test from 'node:test';
import { Ahrs, DEFAULTS } from '../src/layers/ahrs/estimator/ahrs';
import { cloneState, initialState } from '../src/layers/ahrs/estimator/eskf';
import { ageUnobservedState, predictKinematics } from '../src/layers/ahrs/estimator/kinematics';
import { HeadingTrajectory } from '../src/layers/ahrs/estimator/heading-trajectory';
import { fuseGravity } from '../src/layers/ahrs/estimator/gravity-aiding';
import { correctCorrelatedHeading, headingFusionCost } from '../src/layers/ahrs/estimator/correlated-heading';
import { MotionHeading } from '../src/layers/ahrs/estimator/motion-heading';
import { ACCELERATION, TRANSIENT_ACCELERATION, N } from '../src/layers/ahrs/estimator/state-layout';
import { identity, sandwich, zeros } from '../src/layers/ahrs/estimator/linalg';
import { G, RAD, conjugate, fromEuler, rotate } from '../src/layers/ahrs/estimator/math';
import { covarianceIsPsd } from './helpers/ahrs-motion';

test('coherent rotation allows maneuver acceleration without treating alternating vibration as a turn', () => {
  const states = [false, true].map(vibration => {
    const state = initialState([1, 0, 0, 0], [0, 0, 0], [0, 0, 0], false, DEFAULTS);
    for (let i = 0; i < 500; i++) predictKinematics(state, { time: i / 50,
      gyro: [0, 0, vibration ? .1 * Math.sin(2 * Math.PI * 10 * i / 50) : .1],
      specificForce: [0, 0, -G] }, .02, DEFAULTS);
    assert.ok(covarianceIsPsd(state.P, N));
    return state;
  });
  const variance = (state: typeof states[number]) => state.P[TRANSIENT_ACCELERATION * N + TRANSIENT_ACCELERATION]!;
  assert.ok(variance(states[0]!) > 10 * variance(states[1]!));
  assert.deepEqual(states[0]!.v, [0, 0, 0], 'rotation changes an allowance, not measured translational acceleration');
  const gap = cloneState(states[0]!);
  ageUnobservedState(gap, 10, DEFAULTS);
  assert.ok(variance(gap) >= variance(states[0]!), 'missing samples must not substitute quiet-flight process noise');
  assert.ok(covarianceIsPsd(gap.P, N));
});

test('heading trajectory refresh preserves a recent turn but cannot retain an unbounded trajectory', () => {
  const trajectory = new HeadingTrajectory(DEFAULTS);
  const state = initialState([1, 0, 0, 0], [0, 0, 0], [0, 0, 0], false, DEFAULTS);
  const sample = (time: number, turning = false) => ({ time,
    gyro: [0, 0, turning ? .1 : 0] as const, specificForce: [0, 0, -G] as const });
  trajectory.reset(state, sample(0));
  for (let i = 1; i <= 35 * 10; i++) trajectory.update(sample(i / 10, i / 10 >= 28));
  assert.equal(trajectory.needsRefresh(35), false, 'do not discard turn evidence at the periodic refresh boundary');
  for (let i = 351; i <= 46 * 10; i++) trajectory.update(sample(i / 10));
  assert.equal(trajectory.needsRefresh(46), true, 'refresh after the delayed-fix confirmation allowance');
  for (let i = 461; i <= 61 * 10; i++) trajectory.update(sample(i / 10, true));
  assert.equal(trajectory.needsRefresh(61), true, 'continuous rotation cannot defeat the maximum trajectory age');
});

test('persistent acceleration drives velocity without mean reversion while its uncertainty ages', () => {
  const state = initialState([1, 0, 0, 0], [0, 0, 0], [0, 0, 0], true, DEFAULTS);
  state.acceleration = [2, -1, .5]; state.transientAcceleration = [3, 0, 0];
  predictKinematics(state, { time: 0, gyro: [0, 0, 0], specificForce: [100, 100, 100] }, 2, DEFAULTS);
  assert.deepEqual(state.acceleration, [2, -1, .5]);
  assert.ok(Math.abs(state.transientAcceleration[0] - 3 * Math.exp(-2 / 5)) < 1e-10);
  assert.ok(Math.abs(state.v[0] - (4 + 15 * (1 - Math.exp(-2 / 5)))) < 1e-10);
  assert.ok(Math.abs(state.v[1] + 2) < 1e-10);
  assert.ok(Math.abs(state.v[2] - 1) < 1e-10);
  for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(state.P[(ACCELERATION + axis) * N + ACCELERATION + axis]! -
    (DEFAULTS.initialAccelerationStd ** 2 + 2 * DEFAULTS.persistentAccelerationWalk ** 2)) < 1e-10);
});

test('ambiguous force observations retain accelerometer-bias uncertainty without calibrating its mean', () => {
  const state = initialState([1, 0, 0, 0], [0, 0, 0], [0, 0, 0], true, DEFAULTS);
  const variance = state.P[9 * N + 9]!;
  fuseGravity(state, { time: 1, force: [1, .5, -G], variance: .2 }, DEFAULTS);
  assert.deepEqual(state.ba, [0, 0, 0]);
  assert.equal(state.P[9 * N + 9], variance);
  assert.ok(state.acceleration[0] + state.transientAcceleration[0] > 0);
});

test('a stream of rejected GPS innovations cannot suppress accelerometer corrections', () => {
  const filter = new Ahrs({ gpsVelocityStd: .05 });
  filter.update({ time: 0, gyro: [0, 0, 0], specificForce: [0, 0, -G] });
  filter.alignHeading(0);
  filter.updateGps({ time: 0, speed: 50, track: 0, accuracy: 1, altitude: null, altitudeAccuracy: null });
  for (let i = 1; i <= 200; i++) {
    const time = i / 20;
    filter.update({ time, gyro: [0, 0, 0], specificForce: [0, 0, -G] });
    if (i % 20 === 0) filter.updateGps({ time, speed: 500, track: 90, accuracy: 1, altitude: null, altitudeAccuracy: null });
  }
  const result = filter.getState(10);
  assert.ok(result.fusion.rejected > 0);
  assert.ok(result.tiltFusion.accepted > 190);
  assert.equal(result.tiltAiding, true);
});

test('repeating a correlated compass does not average its noise floor away', () => {
  const state = initialState([1, 0, 0, 0], [0, 0, 0], [0, 0, 0], true, { ...DEFAULTS, initialHeadingStd: 60 });
  const H = zeros(1, N); H[8] = 1;
  let accepted = 0;
  for (let i = 0; i < 100; i++) {
    const trace = state.P[6 * N + 6]! + state.P[7 * N + 7]! + state.P[8 * N + 8]!;
    const cost = headingFusionCost(state, DEFAULTS);
    const result = correctCorrelatedHeading(state, () => ({ residual: [0], H, variance: [(10 * RAD) ** 2] }), i, DEFAULTS,
      gain => { const yaw = gain[8]!; gain.fill(0); gain[8] = yaw; });
    if (result === 'accepted') accepted++;
    assert.ok(state.P[8 * N + 8]! >= (10 * RAD) ** 2 - 1e-12);
    assert.ok(state.P[6 * N + 6]! + state.P[7 * N + 7]! + state.P[8 * N + 8]! <= trace + 1e-12);
    assert.ok(headingFusionCost(state, DEFAULTS) <= cost + 1e-12);
  }
  assert.ok(accepted > 0);
});

test('a heading improvement cannot spend arbitrarily large calibration uncertainty', () => {
  const state = initialState([1, 0, 0, 0], [0, 0, 0], [0, 0, 0], true, { ...DEFAULTS, initialHeadingStd: 60 });
  state.P[9 * N + 9] = 1e6;
  const before = state.P.slice(), H = zeros(1, N); H[8] = 1;
  const result = correctCorrelatedHeading(state, () => ({ residual: [0], H, variance: [(5 * RAD) ** 2] }), 1, DEFAULTS,
    gain => { const yaw = gain[8]!; gain.fill(0); gain[8] = yaw; });
  assert.equal(result, 'uninformative');
  assert.deepEqual(state.P, before);
  assert.equal(state.magnetic.rejected, 0);
});

test('qualified gravity reacquires a sixty-degree missed rotation without relaxing the normal tracker', () => {
  const filter = new Ahrs({ recoverAfterGap: true });
  filter.update({ time: 0, gyro: [0, 0, 0], specificForce: [0, 0, -G] });
  const force = rotate(conjugate(fromEuler(0, 60 * RAD, 0)), [0, 0, -G]);
  filter.update({ time: 5, gyro: [0, 0, 0], specificForce: force });
  const before = filter.getState(5).tiltStd;
  for (let i = 1; i <= 200; i++) filter.update({ time: 5 + i / 20, gyro: [0, 0, 0], specificForce: force });
  const after = filter.getState(15);
  assert.notEqual(after.status, 'interrupted');
  assert.ok(Math.abs(after.pitch - 60) < 10);
  assert.ok(after.tiltStd < before);
  assert.equal(after.headingStatus, 'acquiring');
});

test('a tracking-range failure requests recovery without continually restarting its quiet window', () => {
  const state = initialState([1, 0, 0, 0], [0, 0, 0], [0, 0, 0], false, { ...DEFAULTS, initialTiltStd: 60 });
  const force = rotate(conjugate(fromEuler(0, 60 * RAD, 0)), [0, 0, -G]);
  for (let i = 0; i < 3; i++) {
    fuseGravity(state, { time: 10 + i / 10, force, gyro: [0, 0, 0], variance: .1 }, DEFAULTS);
    assert.equal(state.reacquiring, true);
    assert.equal(state.tilt.accepted, 0, 'fresh qualification is required before nonlinear recovery');
    assert.equal(state.tilt.quietSince, 10, 'repeated tracking-range failures do not starve recovery');
  }
});

test('heading-fit uncertainty retains a shared curved-trajectory error across overlapping windows', () => {
  const fit = new MotionHeading(), prior = zeros(N);
  // One common nuisance error rotates the entire velocity history. Its repeated
  // appearance is a single uncertainty, not independent noise at each fix.
  prior[9 * N + 9] = (12 * RAD) ** 2;
  let alignment: ReturnType<MotionHeading['observe']> = null;
  for (let time = 0; time <= 18; time++) {
    const state = initialState([1, 0, 0, 0], [0, 0, 0], [0, 0, 0], false, DEFAULTS);
    const x = 50 + 12 * Math.sin(time / 3), y = 15 * Math.cos(time / 4);
    state.v = [x, y, 0];
    const transition = identity(N);
    transition[3 * N + 9] = -y; transition[4 * N + 9] = x;
    state.P = sandwich(transition, prior, N, N);
    const evidence = { state, transition };
    alignment = fit.observe({ time, velocityNed: [x, y, 0], speed: null, track: null,
      accuracy: 1, altitude: null, altitudeAccuracy: null }, evidence, evidence, .1);
  }
  assert.ok(alignment);
  assert.ok(alignment.headingStdDegrees >= 11.9, 'common uncertainty must not shrink as 1/sqrt(samples)');
});
