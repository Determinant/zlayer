import { covarianceIsPsd } from './helpers/ahrs-motion';
import { ACCELERATION, MAGNETIC_BIAS, MAGNETIC_BIAS_WALK, MAGNETIC_FIELD, MAGNETIC_FIELD_WALK, N } from '../src/layers/ahrs/estimator/state-layout';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Ahrs, DEFAULTS } from '../src/layers/ahrs/estimator/ahrs';
import { G, RAD, type Vec3 } from '../src/layers/ahrs/estimator/math';
import { turn } from './helpers/ahrs-motion';

for (const heading of [false, true]) for (const gap of [.3, .8, 5]) {
  test(`automatic recovery retains calibration across a ${gap}s gap, heading=${heading}`, () => {
    const filter = new Ahrs({ recoverAfterGap: true, gravityAiding: false });
    const bias: Vec3 = [.01, -.005, .002], gyro: Vec3 = [bias[0] + 10 * RAD, bias[1], bias[2]];
    const sample = (time: number) => ({ time, gyro, specificForce: [0, 0, -G] as Vec3 });
    filter.setGyroBias(bias, .2 * RAD);
    filter.update(sample(0));
    if (heading) filter.alignHeading(65);
    for (let i = 1; i <= 20; i++) filter.update(sample(i / 20));
    const fix = (time: number) => ({ time, speed: 50, track: 65, accuracy: 5, altitude: null, altitudeAccuracy: null });
    filter.updateGps(fix(1));
    filter.updateGps(fix(1 + gap / 2)); // Pending evidence from the missing interval.
    const before = filter.getState(1);
    const resumed = filter.update(sample(1 + gap));
    assert.notEqual(resumed.status, 'interrupted');
    assert.deepEqual(resumed.quaternion, before.quaternion, 'do not invent motion across the gap or reset to level');
    assert.deepEqual(resumed.bias, before.bias);
    assert.deepEqual(resumed.accelBias, before.accelBias);
    assert.ok(resumed.tiltStd > before.tiltStd, 'missing motion increases uncertainty');
    assert.equal(resumed.gpsAiding, false);
    assert.equal(resumed.tiltAiding, false);
    assert.notEqual(resumed.headingStatus, 'tracking', 'missing rotation releases the geographic heading reference');
    assert.equal(resumed.gps, null);
    const covariance = filter.getCovariance();
    assert.ok(covarianceIsPsd(covariance, N), 'recovery preserves valid covariance');
    filter.updateGps(fix(1 + gap / 2));
    assert.deepEqual(filter.getCovariance(), covariance, 'late GPS cannot replay the discarded gap');
    const moving = filter.update(sample(1 + gap + .05));
    assert.ok(moving.roll > resumed.roll + .4, 'new readings resume integration immediately');
    assert.notEqual(moving.status, 'interrupted');
  });
}

test('repeated gaps remain recoverable without reducing uncertainty or changing gyro bias', () => {
  const filter = new Ahrs({ recoverAfterGap: true });
  const sample = (time: number) => ({ time, gyro: [0, 0, 0] as Vec3, specificForce: [0, 0, -G] as Vec3 });
  let previous = filter.update(sample(0));
  for (let i = 1; i <= 30; i++) {
    const current = filter.update(sample(i));
    assert.notEqual(current.status, 'interrupted');
    assert.ok(current.tiltStd >= previous.tiltStd);
    assert.deepEqual(current.bias, previous.bias);
    assert.deepEqual(current.quaternion, previous.quaternion);
    assert.ok(covarianceIsPsd(filter.getCovariance(), N));
    previous = current;
  }
});

for (const gravityAiding of [false, true]) test(`a long pause ages retained calibration without integrating missing motion, gravity=${gravityAiding}`, () => {
  const filter = new Ahrs({ recoverAfterGap: true, gravityAiding });
  const sample = (time: number) => ({ time, gyro: [0, 0, 0] as Vec3, specificForce: [0, 0, -G] as Vec3 });
  const before = filter.update(sample(0)), covariance = filter.getCovariance(), gap = 3600;
  const after = filter.update(sample(gap)), aged = filter.getCovariance();
  assert.deepEqual(after.quaternion, before.quaternion);
  assert.deepEqual(after.bias, before.bias);
  assert.deepEqual(after.accelBias, before.accelBias);
  for (const [offset, density] of [[9, DEFAULTS.accelBiasWalk], [12, DEFAULTS.gyroBiasWalk],
    [MAGNETIC_FIELD, MAGNETIC_FIELD_WALK], [MAGNETIC_BIAS, MAGNETIC_BIAS_WALK],
    [ACCELERATION, gravityAiding ? DEFAULTS.persistentAccelerationWalk : 0]] as const)
    for (let axis = 0; axis < 3; axis++) {
      const index = (offset + axis) * N + offset + axis;
      assert.ok(Math.abs(aged[index]! - covariance[index]! - density ** 2 * gap) < 1e-10);
    }
});

for (const gap of [.8, 5]) test(`fresh GPS can rebuild tilt and heading aiding after a ${gap}s motion pause`, () => {
  const filter = new Ahrs({ recoverAfterGap: true });
  filter.setGyroBias([0, 0, 0], .2 * RAD);
  filter.update(turn(0, 65).sample);
  filter.alignHeading(65);
  let tiltAided = false;
  const start = 1 + gap;
  for (let i = 0; i <= 90 * 50; i++) {
    const time = start + i / 50;
    // Level flight first supplies tilt evidence; a later turn supplies heading.
    const truth = turn(Math.max(0, i / 50 - 35), 65);
    filter.update({ ...truth.sample, time });
    if (i % 50 === 0) filter.updateGps({ ...truth.fix, time });
    const state = filter.getState(time);
    assert.notEqual(state.status, 'interrupted', state.reason);
    tiltAided ||= state.tiltAiding;
  }
  const state = filter.getState(start + 90), truth = turn(55, 65);
  assert.ok(tiltAided, 'fresh steady flight can reduce uncertainty after the gap');
  assert.equal(state.headingReference, 'gps-inertial', 'the initial manual heading is not reapplied');
  assert.equal(state.headingStatus, 'tracking');
  assert.equal(state.gpsAiding, true);
  assert.ok(state.tiltStd < 3);
  assert.ok(Math.abs(state.roll - truth.roll / RAD) < 3);
  assert.ok(Math.abs(Math.atan2(Math.sin(state.yaw * RAD - truth.yaw), Math.cos(state.yaw * RAD - truth.yaw))) < 3 * RAD);
  assert.ok(covarianceIsPsd(filter.getCovariance(), N));
});
