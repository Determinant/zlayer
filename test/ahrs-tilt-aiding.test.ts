import { covarianceIsPsd } from './helpers/ahrs-motion';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Ahrs, DEFAULTS } from '../src/layers/ahrs/estimator/ahrs';
import { fuseGravity } from '../src/layers/ahrs/estimator/gravity-aiding';
import { initialState } from '../src/layers/ahrs/estimator/eskf';
import { predictKinematics } from '../src/layers/ahrs/estimator/kinematics';
import { ACCELERATION, N } from '../src/layers/ahrs/estimator/state-layout';
import { G, RAD } from '../src/layers/ahrs/estimator/math';
import type { GpsFix } from '../src/layers/ahrs/estimator/types';
import { turn, vibratingLevelFlight } from './helpers/ahrs-motion';

for (const hz of [30, 60]) test(`three minutes of angular and linear vibration retain unaided tilt at ${hz} Hz`, () => {
  const filter = new Ahrs();
  filter.setGyroBias([0, 0, 0], .2 * RAD);
  let maxTiltError = 0;
  for (let i = 0; i <= 180 * hz; i++) {
    const time = i / hz, sample = vibratingLevelFlight(time);
    // Match the 0.08 and -0.1 degree/s tilt biases of the quiet/noisy drift cases,
    // adding actual roll rocking and 8 Hz angular vibration to their force noise.
    filter.update({ ...sample, gyro: [sample.gyro[0] - .07 * RAD, sample.gyro[1], sample.gyro[2]] });
    const truthRoll = .8 * Math.sin(2 * Math.PI * .2 * time) + 5 / (2 * Math.PI * 8) * Math.sin(2 * Math.PI * 8 * time);
    const state = filter.getState(time);
    maxTiltError = Math.max(maxTiltError, Math.abs(state.roll - truthRoll), Math.abs(state.pitch));
    assert.notEqual(state.status, 'interrupted');
  }
  const state = filter.getState(180);
  assert.ok(maxTiltError < 4, `maximum tilt error ${maxTiltError}`);
  assert.ok(state.tiltStd > 1 && state.tiltStd < 10);
  assert.ok(covarianceIsPsd(filter.getCovariance(), N));
});

for (const noisy of [false, true]) test(`three minutes without GPS corrects tilt drift (${noisy ? 'vibration' : 'quiet'})`, () => {
  const filter = new Ahrs();
  filter.setGyroBias([0, 0, 0], .2 * RAD);
  filter.update({ time: 0, gyro: [0, 0, 0], specificForce: [0, 0, -G] });
  for (let i = 1; i <= 180 * 20; i++) {
    const time = i / 20, vibration = noisy ? .7 * Math.sin(13.7 * time) : 0;
    filter.update({ time, gyro: [.08 * RAD, -.1 * RAD, 0], specificForce: [vibration, -vibration, -G + vibration / 2] });
    assert.notEqual(filter.getState(time).status, 'interrupted');
  }
  const state = filter.getState(180);
  assert.ok(state.tiltFusion.accepted > 500, 'no twenty-second all-or-nothing gate');
  assert.ok(Math.abs(state.roll) < 4 && Math.abs(state.pitch) < 4);
  assert.ok(state.tiltStd > 1 && state.tiltStd < 10, 'retain the initial acceleration/tilt ambiguity');
  assert.ok(Math.abs(state.bias[0] / RAD - .08) < .05 && Math.abs(state.bias[1] / RAD + .1) < .05);
  assert.equal(state.tiltAiding, true);
  assert.equal(state.attitudeStd[2], Infinity);
  assert.ok(covarianceIsPsd(filter.getCovariance(), N));
});

test('constant horizontal acceleration is represented jointly, not forced into pitch', () => {
  const state = initialState([1, 0, 0, 0], [0, 0, 0], [0, 0, 0], true, DEFAULTS);
  const before = state.P[7 * N + 7]!;
  for (let i = 1; i <= 50; i++) {
    predictKinematics(state, { time: (i - 1) / 5, gyro: [0, 0, 0], specificForce: [3, 0, -G] }, .2, DEFAULTS);
    fuseGravity(state, { time: i / 5, force: [3, 0, -G], variance: .5 }, DEFAULTS);
  }
  assert.ok(state.acceleration[0] + state.transientAcceleration[0] > 2, 'most of the unexplained force remains acceleration');
  assert.ok(Math.abs(state.q[2]) < .05, 'must not turn 3 m/s² into a 17° pitch correction');
  assert.ok(state.P[7 * N + 7]! > before / 2, 'persistent acceleration ambiguity cannot be averaged away');
  assert.ok(Math.abs(state.P[7 * N + ACCELERATION]!) > 0, 'preserve tilt/acceleration correlation');
});

test('all three accelerometer axes participate, including vertical acceleration and accelerometer bias', () => {
  const state = initialState([1, 0, 0, 0], [0, 0, 0], [0, 0, 0], true, DEFAULTS);
  state.lastVelocityFusion = 1;
  fuseGravity(state, { time: 1, force: [.3, -.4, -G + .5], variance: .5 }, DEFAULTS);
  assert.ok(state.acceleration[0] > 0 && state.acceleration[1] < 0 && state.acceleration[2] > 0);
  assert.ok(state.ba[0] > 0 && state.ba[1] < 0 && state.ba[2] > 0);
  assert.ok(covarianceIsPsd(state.P, N));
});

test('free fall is rejected explicitly and fresh gravity observations recover promptly', () => {
  const filter = new Ahrs();
  for (let i = 0; i <= 100; i++) {
    const time = i / 20;
    filter.update({ time, gyro: [0, 0, 0], specificForce: [0, 0, time >= 1 && time < 3 ? 0 : -G] });
    if (i === 40) {
      const state = filter.getState(time);
      assert.ok(state.tiltFusion.rejected > 0);
      assert.match(state.tiltFusion.reason, /load/);
      assert.equal(state.tiltAiding, false);
    }
  }
  assert.equal(filter.getState(5).tiltAiding, true);
});

test('gravity can be disabled and absence of observations still grows uncertainty', () => {
  const filter = new Ahrs({ gravityAiding: false });
  filter.setGyroBias([0, 0, 0], .2 * RAD);
  for (let i = 0; i <= 60 * 20; i++) filter.update({ time: i / 20, gyro: [0, 0, 0], specificForce: [0, 0, -G] });
  assert.equal(filter.getState(60).tiltFusion.accepted, 0);
  assert.ok(filter.getState(60).tiltStd > 10);
});

for (const delay of [.4, 2.8]) test(`GPS delayed ${delay}s and gravity observations remain simultaneously active`, () => {
  const filter = new Ahrs(), pending: GpsFix[] = [];
  filter.update({ time: 0, gyro: [0, 0, 0], specificForce: [0, 0, -G] });
  filter.alignHeading(0);
  let correctionsAtResume = 0;
  for (let i = 1; i <= 30 * 20; i++) {
    const time = i / 20;
    filter.update({ time, gyro: [0, 0, 0], specificForce: [0, 0, -G] });
    if (i % 20 === 0 && time >= 10) pending.push({ time, speed: 50, track: 0, accuracy: 3, altitude: 1000, altitudeAccuracy: 5 });
    while (pending.length && pending[0]!.time <= time - delay + 1e-9) filter.updateGps(pending.shift()!);
    if (time === 15) correctionsAtResume = filter.getState(time).tiltFusion.accepted;
  }
  const state = filter.getState(30);
  assert.ok(correctionsAtResume > 0);
  assert.ok(state.tiltFusion.accepted > correctionsAtResume);
  if (delay < 2.5) assert.equal(state.gpsAiding, true);
  assert.ok(state.fusion.accepted > 10 && state.altitudeFusion.accepted > 10);
  assert.ok(covarianceIsPsd(filter.getCovariance(), N));
});

for (const noisy of [false, true]) test(`a turn after a minute of gravity aiding can acquire heading (${noisy ? 'noise' : 'ideal'})`, () => {
  const filter = new Ahrs(), pending: GpsFix[] = [];
  filter.setGyroBias([0, 0, 0], .2 * RAD);
  for (let i = 0; i <= 110 * 20; i++) {
    const time = i / 20, truth = turn(Math.max(0, time - 60), 120);
    filter.update({ ...truth.sample, time, ...(noisy ? {
      gyro: [truth.sample.gyro[0] + .001, truth.sample.gyro[1] - .001, truth.sample.gyro[2] + .001] as const,
      specificForce: [truth.sample.specificForce[0] + .03, truth.sample.specificForce[1] - .04, truth.sample.specificForce[2] + .02] as const,
    } : {}) });
    if (i % 20 === 0) pending.push({ ...truth.fix, time });
    while (pending.length && pending[0]!.time <= time - .3 + 1e-9) filter.updateGps(pending.shift()!);
  }
  const state = filter.getState(110), truth = turn(50, 120);
  const yawError = Math.atan2(Math.sin(state.yaw * RAD - truth.yaw), Math.cos(state.yaw * RAD - truth.yaw)) / RAD;
  assert.equal(state.headingReference, 'gps-inertial');
  assert.equal(state.gpsAiding, true);
  assert.ok(Math.abs(yawError) < 5);
  assert.ok(covarianceIsPsd(filter.getCovariance(), N));
});
