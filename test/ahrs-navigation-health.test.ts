import { covarianceIsPsd } from './helpers/ahrs-motion';
import { N } from '../src/layers/ahrs/estimator/state-layout';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Ahrs, DEFAULTS } from '../src/layers/ahrs/estimator/ahrs';
import { initialState, numericallyHealthy, predictInterval } from '../src/layers/ahrs/estimator/eskf';
import { G, RAD, type Vec3 } from '../src/layers/ahrs/estimator/math';

test('twenty minutes of unaided propagation retains attitude and uncertainty across navigation restarts', t => {
  const filter = new Ahrs({ gravityAiding: false });
  filter.setGyroBias([0, 0, 0], .2 * RAD);
  filter.update({ time: 0, gyro: [0, 0, 0], specificForce: [0, 0, -G] });
  let previous = filter.getState(0), restarts = 0;
  const gyro: Vec3 = [0, .02 * RAD, 0], dt = .05;
  for (let i = 1; i <= 1200 / dt; i++) {
    const time = i * dt;
    // An unbounded reference checks that discarding navigation does not reset
    // attitude/bias uncertainty, including its off-diagonal correlations.
    const reference = Math.hypot(...previous.velocity) > 1999
      ? initialState(previous.quaternion, previous.bias, previous.accelBias, false, DEFAULTS) : null;
    if (reference) {
      reference.P = filter.getCovariance();
      predictInterval(reference, { time: time - dt, gyro, specificForce: [0, 0, -G] }, dt, DEFAULTS);
    }
    const state = filter.update({ time, gyro, specificForce: [0, 0, -G] });
    assert.notEqual(state.status, 'interrupted');
    assert.ok(Math.abs(state.pitch - .02 * (time - dt)) < 1e-7, 'attitude keeps integrating the measured rate');
    if (Math.hypot(...previous.velocity) > 1999 && Math.hypot(...state.velocity) < 1) {
      restarts++;
      assert.ok(reference);
      const covariance = filter.getCovariance();
      for (let row = 6; row < N; row++) for (let col = 6; col < N; col++) {
        const expected = reference.P[row * N + col]!;
        assert.ok(Math.abs(covariance[row * N + col]! - expected) < 1e-8 * Math.max(1, Math.abs(expected)));
      }
      assert.deepEqual(state.bias, previous.bias);
      assert.deepEqual(state.accelBias, previous.accelBias);
    }
    previous = state;
  }
  assert.ok(restarts > 0, 'exercise the original >2000 m/s failure');
  assert.equal(previous.status, 'degraded');
  assert.ok(previous.tiltStd > 10, 'navigation restarts do not claim to improve attitude');
  assert.ok(covarianceIsPsd(filter.getCovariance(), N));
  const moving = filter.update({ time: 1200 + dt, gyro: [10 * RAD, 0, 0], specificForce: [0, 0, -G] });
  const rolled = filter.update({ time: 1200 + 2 * dt, gyro: [10 * RAD, 0, 0], specificForce: [0, 0, -G] });
  assert.ok(rolled.roll > moving.roll + .4, 'new rotation still changes the indication');
  t.diagnostic(`Navigation restarts: ${restarts}; final pitch ${previous.pitch.toFixed(3)}°`);
});

test('GPS reinitializes a discarded trajectory without reapplying manual heading or attitude', () => {
  const filter = new Ahrs({ gravityAiding: false, gyroNoise: 1e-6, gyroBiasWalk: 1e-9 });
  filter.setGyroBias([0, 0, 0], 1e-6);
  filter.update({ time: 0, gyro: [0, 0, 0], specificForce: [0, 0, -G] });
  filter.alignHeading(0);
  filter.updateGps({ time: 0, speed: 50, track: 0, accuracy: 5, altitude: null, altitudeAccuracy: null });
  let previous = filter.getState(0), recoveredAt = 0;
  for (let i = 1; i <= 900 * 20; i++) {
    const time = i / 20;
    // Vertical accelerometer error is unobserved by horizontal GPS velocity.
    const state = filter.update({ time, gyro: [0, 0, .01 * RAD], specificForce: [0, 0, -G - 2.5] });
    assert.notEqual(state.status, 'interrupted');
    if (Math.hypot(...previous.velocity) > 1999 && Math.hypot(...state.velocity) < 1) {
      assert.equal(state.headingStatus, 'tracking');
      assert.ok(state.yaw > 5, 'heading has evolved beyond its initial input');
      const covariance = filter.getCovariance();
      filter.updateGps({ time: time - .01, speed: 50, track: 0, accuracy: 5, altitude: null, altitudeAccuracy: null });
      assert.equal(filter.getState(time).gpsAiding, false, 'pre-restart delayed fixes cannot enter the new trajectory');
      filter.updateGps({ time, speed: 50, track: 0, accuracy: 5, altitude: null, altitudeAccuracy: null });
      const recovered = filter.getState(time);
      assert.equal(recovered.gpsAiding, true);
      assert.equal(recovered.fusion.accepted, state.fusion.accepted + 1);
      assert.deepEqual(recovered.quaternion, state.quaternion);
      assert.deepEqual(recovered.bias, state.bias);
      assert.deepEqual(recovered.accelBias, state.accelBias);
      const after = filter.getCovariance();
      for (let row = 6; row < N; row++) for (let col = 6; col < N; col++)
        assert.equal(after[row * N + col], covariance[row * N + col]);
      recoveredAt = time;
      break;
    }
    previous = state;
  }
  assert.ok(recoveredAt > 0);
});

test('numerical health still rejects corrupt state and covariance', () => {
  const fresh = () => initialState([1, 0, 0, 0], [0, 0, 0], [0, 0, 0], true, DEFAULTS);
  assert.equal(numericallyHealthy(fresh()), true);
  assert.equal(numericallyHealthy(initialState([1, 0, 0, 0], [0, 0, 0], [0, 0, 0], false, DEFAULTS)), true,
    'a defined local yaw gauge is valid semidefinite covariance');
  const nonfinite = fresh(); nonfinite.v = [NaN, 0, 0];
  assert.equal(numericallyHealthy(nonfinite), false);
  const covariance = fresh(); covariance.P[0] = -1;
  assert.equal(numericallyHealthy(covariance), false);
  const quaternion = fresh(); quaternion.q = [2, 0, 0, 0];
  assert.equal(numericallyHealthy(quaternion), false);
});
