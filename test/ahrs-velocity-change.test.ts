import assert from 'node:assert/strict';
import test from 'node:test';
import { Ahrs, DEFAULTS } from '../src/layers/ahrs/estimator/ahrs';
import { cloneState, fuseGps, initialState, restartNavigation } from '../src/layers/ahrs/estimator/eskf';
import { fuseVelocityChange } from '../src/layers/ahrs/estimator/velocity-change';
import { N, VELOCITY_ANCHOR } from '../src/layers/ahrs/estimator/state-layout';
import { G, RAD } from '../src/layers/ahrs/estimator/math';
import type { GpsFix } from '../src/layers/ahrs/estimator/types';
import { covarianceIsPsd } from './helpers/ahrs-motion';

const config = { ...DEFAULTS, gpsVelocityStd: 1 };
const fix = (time: number, n = 50, e = 0): GpsFix => ({ time, speed: null, track: null,
  velocityNed: [n, e, 0], accuracy: 3, altitude: null, altitudeAccuracy: null });
const initial = () => initialState([1, 0, 0, 0], [0, 0, 0], [0, 0, 0], false, config);

test('a velocity clone preserves common endpoint error; zero change has the closed-form Gaussian posterior', () => {
  const state = initial();
  state.P[3 * N + 3] = state.P[4 * N + 4] = 1;
  fuseVelocityChange(state, fix(0), config);
  assert.equal(state.P[3 * N + VELOCITY_ANCHOR], 1);
  assert.ok(covarianceIsPsd(state.P, N));
  // Independent velocity increment variance 4, plus common origin variance 1.
  state.P[3 * N + 3]! += 4; state.P[4 * N + 4]! += 4;
  state.v = [2, 0, 0];
  fuseVelocityChange(state, fix(2), config);
  assert.equal(state.accepted, 1);
  assert.ok(Math.abs(state.v[0] - 2 / 3) < 1e-12);
  assert.ok(Math.abs(state.P[3 * N + 3]! - 7 / 3) < 1e-12);
  assert.equal(state.gpsAnchor, null);
  assert.ok(covarianceIsPsd(state.P, N));
  fuseVelocityChange(state, fix(3), config);
  assert.equal(cloneState(state).gpsAnchor?.time, 3, 'a consumed endpoint cannot seed the next pair');
  assert.equal(state.accepted, 1);
});

test('nonzero observed change retains direction ambiguity and is invariant to GPS north rotation', () => {
  const results: Float64Array[] = [];
  for (const rotation of [0, .73, Math.PI / 2]) {
    const state = initial(), c = Math.cos(rotation), s = Math.sin(rotation);
    state.P[3 * N + 3] = state.P[4 * N + 4] = 1;
    fuseVelocityChange(state, fix(0, 50 * c, 50 * s), config);
    state.P[3 * N + 3]! += 4; state.P[4 * N + 4]! += 4;
    fuseVelocityChange(state, fix(2, 52 * c, 52 * s), config);
    assert.ok(Math.abs(state.v[0]) < 1e-12 && Math.abs(state.v[1]) < 1e-12);
    // P_cond + K Var(direction | radius) Kᵀ, not a zero-change pseudo-reading.
    assert.ok(Math.abs(state.P[3 * N + 3]! - 29 / 9) < 1e-12);
    assert.ok(covarianceIsPsd(state.P, N));
    results.push(state.P);
  }
  results[0]!.forEach((value, i) => assert.ok(Math.abs(value - results[1]![i]!) < 1e-12));
});

test('maneuvers, long GPS gaps and navigation resets do not become steady-flight constraints', () => {
  const state = initial();
  fuseVelocityChange(state, fix(0), config);
  fuseVelocityChange(state, fix(2, 50, 20), config);
  assert.equal(state.accepted, 0); assert.equal(state.gpsAnchor, null);
  fuseVelocityChange(state, fix(3), config);
  fuseVelocityChange(state, fix(20), config);
  assert.equal(cloneState(state).gpsAnchor?.time, 20); assert.equal(state.accepted, 0);
  const copied = cloneState(state);
  assert.notEqual(copied.gpsAnchor, state.gpsAnchor);
  const restarted = restartNavigation(state, state.q, config);
  assert.equal(restarted.gpsAnchor, null);
  assert.equal(restarted.lastVelocityFusion, -Infinity);
  assert.equal(restarted.P[VELOCITY_ANCHOR * N + VELOCITY_ANCHOR], 0);
});

test('vertical velocity and altitude fuse before north alignment', () => {
  const state = initial();
  fuseGps(state, { ...fix(0), velocityNed: [50, 10, -2], altitude: 1000, altitudeAccuracy: 5 }, config, undefined, false);
  assert.deepEqual(state.v, [0, 0, -2]);
  assert.equal(state.velocityInitialized, false);
  assert.equal(state.verticalVelocityInitialized, true);
  fuseGps(state, { ...fix(1), velocityNed: [50, 10, -2], altitude: 1002, altitudeAccuracy: 5 }, config, undefined, false);
  assert.equal(state.lastVerticalVelocityFusion, 1);
  assert.equal(state.lastAltitudeFusion, 1);
  assert.equal(state.lastVelocityFusion, -Infinity);
});

function straightFlight(gps: boolean, delay = 0) {
  const filter = new Ahrs(), pending: GpsFix[] = [];
  filter.setGyroBias([0, 0, 0], .2 * RAD);
  for (let i = 0; i <= 120 * 20; i++) {
    const time = i / 20;
    filter.update({ time, gyro: [.06 * RAD, -.08 * RAD, 0], specificForce: [0, 0, -G] });
    if (gps && i % 60 === 0 && time <= 117) pending.push(fix(time));
    while (pending.length && pending[0]!.time <= time - delay + 1e-9) filter.updateGps(pending.shift()!);
  }
  return filter;
}

test('intermittent GPS constrains two-minute straight-flight tilt without inventing heading', () => {
  const aided = straightFlight(true).getState(120), unaided = straightFlight(false).getState(120);
  assert.ok(aided.fusion.accepted > 10);
  assert.ok(aided.tiltStd < unaided.tiltStd);
  assert.ok(Math.abs(aided.roll) < 3 && Math.abs(aided.pitch) < 3);
  assert.equal(aided.headingStatus, 'acquiring');
  assert.equal(aided.attitudeStd[2], Infinity);
});

test('delayed unaligned GPS reproduces the chronological clone and correction history', () => {
  const immediate = straightFlight(true), delayed = straightFlight(true, .4);
  const a = immediate.getState(120), b = delayed.getState(120);
  assert.equal(a.fusion.accepted, b.fusion.accepted);
  a.quaternion.forEach((value, i) => assert.ok(Math.abs(value - b.quaternion[i]!) < 1e-10));
  immediate.getCovariance().forEach((value, i) => assert.ok(Math.abs(value - delayed.getCovariance()[i]!) < 1e-8));
  assert.ok(covarianceIsPsd(delayed.getCovariance(), N));
});
