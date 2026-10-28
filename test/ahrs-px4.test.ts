import assert from 'node:assert/strict';
import test from 'node:test';
import { Ahrs, DEFAULTS } from '../src/layers/ahrs/estimator/ahrs';
import { N } from '../src/layers/ahrs/estimator/state-layout';
import { G, RAD, rotate, type Vec3 } from '../src/layers/ahrs/estimator/math';
import { FlightAlignment } from '../src/layers/ahrs/estimator/flight-alignment';
import type { GpsFix, Observation } from '../src/layers/ahrs/estimator/types';
import { covarianceIsPsd, mountedVibration, turn } from './helpers/ahrs-motion';

const quiet = (time: number, gyro: Vec3 = [0, 0, 0]) => ({ time, gyro, specificForce: [0, 0, -G] as Vec3 });
const gps = (time: number, change: Partial<GpsFix> = {}): GpsFix => ({ time, coordinates: [-122, 37],
  speed: 0, track: null, accuracy: 5, altitude: null, altitudeAccuracy: null, ...change });

test('PX4 defaults keep mounted vibration bounded before north alignment without asserting rest', t => {
  assert.equal(DEFAULTS.gravityAiding, false, 'preserve the upstream default IMU control mask');
  const gate = new FlightAlignment({ requireVerticalEvidence: false, allowUnaided: true, pauseOnGap: true });
  for (let i = 1; i <= 500; i++) gate.observeImu(mountedVibration(i / 50));
  const solution = gate.snapshot(10).solution!;
  assert.ok(solution);
  const a = new Ahrs(); t.after(() => a.dispose());
  const trim = solution.levelTrim;
  a.setGyroBias(rotate(trim, solution.gyroBias), solution.gyroBiasStd);
  a.setInitialAttitude([1, 0, 0, 0]);
  let peak = 0;
  for (let i = 450; i <= 3600; i++) {
    const sample = mountedVibration(i / 50);
    const state = a.update({ ...sample, gyro: rotate(trim, sample.gyro), specificForce: rotate(trim, sample.specificForce) });
    if (i >= 600) peak = Math.max(peak, Math.abs(state.roll), Math.abs(state.pitch));
  }
  assert.ok(peak < 3, `peak tilt ${peak}°`);
  assert.equal(a.getState(72).tiltFusion.accepted, 0);
});

for (const hz of [20, 30, 60, 120]) test(`calibrated PX4 keeps bounded vibration below 3° at ${hz} Hz`, t => {
  const a = new Ahrs(); t.after(() => a.dispose());
  const bias: Vec3 = [.3 * RAD, -.3 * RAD, .2 * RAD];
  const sample = (time: number) => {
    const vibration = Math.sin(2 * Math.PI * 7.3 * time);
    return { time, gyro: [bias[0] + 3 * RAD * vibration, bias[1] + 2 * RAD * vibration, bias[2] + 2 * RAD * vibration] as Vec3,
      specificForce: [2 * vibration, 1.5 * vibration, -G + 3 * vibration] as Vec3 };
  };
  const gate = new FlightAlignment({ requireVerticalEvidence: false, allowUnaided: true, pauseOnGap: true });
  for (let i = 1; i <= 10 * hz; i++) gate.observeImu(sample(i / hz));
  const solution = gate.snapshot(10).solution;
  assert.ok(solution, 'normal calibration accepts the delivered vibration');
  const trim = solution.levelTrim;
  a.setGyroBias(rotate(trim, solution.gyroBias), solution.gyroBiasStd);
  a.setInitialAttitude([1, 0, 0, 0]);
  let peak = 0;
  for (let i = 9 * hz; i <= 70 * hz; i++) {
    const input = sample(i / hz);
    const state = a.update({ ...input, gyro: rotate(trim, input.gyro), specificForce: rotate(trim, input.specificForce) });
    peak = Math.max(peak, Math.abs(state.roll), Math.abs(state.pitch));
  }
  assert.ok(peak < 3, `peak tilt ${peak}°`);
  assert.equal(a.getCovariance().length, N * N);
  assert.ok(covarianceIsPsd(a.getCovariance(), N));
});

test('zero GPS speed does not suppress real rotation or require a mode change', t => {
  const a = new Ahrs(); t.after(() => a.dispose());
  for (let i = 0; i <= 1200; i++) {
    a.update(quiet(i / 60));
    if (i % 60 === 0) a.updateGps(gps(i / 60));
  }
  const yaw = a.getState(20).yaw;
  for (let i = 1201; i <= 1320; i++) {
    a.update(quiet(i / 60, [0, 0, 10 * RAD]));
    if (i % 60 === 0) a.updateGps(gps(i / 60));
  }
  const delta = (a.getState(22).yaw - yaw + 540) % 360 - 180;
  assert.ok(Math.abs(delta - 20) < .3, `real rotation ${delta}°`);
});

test('disposed native instances reject access without affecting another estimator', t => {
  const disposed = new Ahrs(), live = new Ahrs(); t.after(() => live.dispose());
  disposed.dispose(); disposed.dispose();
  for (const access of [() => disposed.setGyroBias([0, 0, 0]), () => disposed.setInitialAttitude([1, 0, 0, 0]),
    () => disposed.update(quiet(0)), () => disposed.updateGps(gps(0)),
    () => disposed.updateMagnetic({ time: 0, vector: [20, 0, 40], source: 'magnetometer' }),
    () => disposed.alignHeading(0), () => disposed.getState(0), () => disposed.getCovariance(), () => disposed.reset()])
    assert.throws(access, /disposed/);
  for (let i = 0; i <= 60; i++) live.update(quiet(i / 60));
  assert.ok(Math.abs(live.getState(1).roll) < .01);
});

test('calibration seeds the output predictor as well as the delayed EKF', t => {
  const a = new Ahrs(); t.after(() => a.dispose());
  const bias: Vec3 = [.002, -.003, .004];
  a.setGyroBias(bias, .05 * RAD);
  for (let i = 0; i <= 120; i++) a.update(quiet(i / 60, bias));
  const state = a.getState(2);
  assert.ok(Math.abs(state.roll) < .01 && Math.abs(state.pitch) < .01);
  assert.ok(Math.min(state.yaw, 360 - state.yaw) < .01);
});

test('confirmed level calibration supplies the prior instead of the first vibrating force vector', t => {
  const a = new Ahrs(); t.after(() => a.dispose());
  a.setInitialAttitude([1, 0, 0, 0]);
  const s = a.update({ time: 0, gyro: [0, 0, 0], specificForce: [3, 2, -G] });
  assert.equal(s.roll, 0); assert.equal(s.pitch, 0);
  assert.throws(() => a.setInitialAttitude([1, 0, 0, 0]), /Invalid initial/);
});

test('a gap holds pose, releases north confidence, and resumes without inventing missing rotation', t => {
  const a = new Ahrs({ recoverAfterGap: true }); t.after(() => a.dispose());
  a.setGyroBias([.001, 0, 0]);
  for (let i = 0; i <= 600; i++) a.update(quiet(i / 60, [.001, 0, 0]));
  a.alignHeading(70);
  const before = a.getState(10);
  const resumed = a.update({ time: 15, gyro: [1, 0, 0], specificForce: [0, 0, -1.5 * G] });
  assert.ok(resumed.quaternion.every((q, i) => Math.abs(q - before.quaternion[i]!) < 1e-6));
  assert.equal(resumed.headingStatus, 'recovering');
  assert.ok(resumed.tiltStd > before.tiltStd);
  assert.ok(resumed.bias.every((v, i) => Math.abs(v - before.bias[i]!) < 1e-7));
  assert.ok(resumed.accelBias.every((v, i) => Math.abs(v - before.accelBias[i]!) < 1e-7));
  a.update(quiet(15.02, [.001, 0, 10 * RAD]));
  assert.notEqual(a.getState(15.02).status, 'waiting');
  const stopped = new Ahrs(); t.after(() => stopped.dispose());
  stopped.update(quiet(0)); stopped.update(quiet(1));
  assert.equal(stopped.getState(1).status, 'interrupted');
});

test('browser GPS fuses only reported velocity axes and requires health qualification', t => {
  const observations: Observation[] = [];
  const a = new Ahrs({}, value => observations.push(value)); t.after(() => a.dispose());
  a.setGyroBias([0, 0, 0], .1 * RAD); a.alignHeading(0);
  for (let i = 0; i <= 1800; i++) {
    const time = i / 60; a.update(quiet(time));
    if (i % 60 === 0) a.updateGps(gps(time));
    if (i === 300) assert.equal(a.getState(time).gpsAiding, false, 'five seconds cannot satisfy the ten-second health gate');
  }
  const velocity = observations.filter(o => o.source === 'velocity' && o.result === 'accepted');
  assert.ok(velocity.length > 10);
  assert.ok(velocity.every(o => o.dimension === 2));
  assert.equal(a.getState(30).verticalSpeed, null, 'missing vertical measurements do not become zero speed');
  assert.equal(observations.filter(o => o.source === 'altitude').length, 0, 'missing height has no fabricated innovation');
  const count = a.getState(30).fusion.accepted;
  a.updateGps(gps(30, { estimated: true }));
  a.updateGps(gps(20));
  assert.equal(a.getState(30).fusion.accepted, count);
  assert.ok(a.getState(30).fusion.stale > 0);
});

test('GNSS motion acquires yaw and a later explicit heading keeps its newer source identity', t => {
  const a = new Ahrs(); t.after(() => a.dispose());
  a.setGyroBias([0, 0, 0], .2 * RAD);
  for (let i = 0; i <= 3600; i++) {
    const time = i / 60, truth = turn(Math.max(0, time - 15), 75);
    a.update({ ...truth.sample, time });
    if (i % 60 === 0) a.updateGps({ ...truth.fix, time });
  }
  assert.equal(a.getState(60).headingReference, 'gps-inertial');
  const error = (a.getState(60).yaw - turn(45, 75).yaw / RAD + 540) % 360 - 180;
  assert.ok(Math.abs(error) < 3, `GNSS/inertial yaw error ${error}°`);
  a.alignHeading(20); a.update(quiet(60.02));
  assert.equal(a.getState(60.02).headingReference, 'manual-true');
});

test('raw magnetometer and OS-fused compass retain distinct input contracts', t => {
  const a = new Ahrs(); t.after(() => a.dispose());
  for (let i = 0; i <= 1200; i++) {
    const time = i / 60; a.update(quiet(time));
    if (i % 6 === 0) a.updateMagnetic({ time, source: 'absolute-orientation', vector: [1, 0, 0] });
  }
  assert.equal(a.getState(20).magneticFusion.active, false);
  assert.equal(a.getState(20).headingReference, 'relative');
  assert.match(a.getState(20).magneticFusion.reason, /OS-fused/);
  for (let i = 1201; i <= 2400; i++) {
    const time = i / 60; a.update(quiet(time));
    if (i % 6 === 0) a.updateMagnetic({ time, source: 'magnetometer', vector: [20, 0, 40] });
  }
  assert.ok(a.getState(40).magneticFusion.accepted > 0);
  assert.equal(a.getState(40).magneticFusion.mode, 'vector', 'report the mode selected by PX4 without a ground constraint');
  assert.equal(a.getState(40).headingReference, 'relative', 'a raw magnetic alignment alone is not verified true north');
});

test('calibrated PX4 tracks a coordinated turn with an independently supplied heading', t => {
  const a = new Ahrs(); t.after(() => a.dispose());
  a.setGyroBias([0, 0, 0], .2 * RAD); a.alignHeading(75);
  let peak = 0;
  for (let i = 0; i <= 60 * 60; i++) {
    const time = i / 60, truth = turn(Math.max(0, time - 15), 75);
    const state = a.update({ ...truth.sample, time });
    if (i % 60 === 0) a.updateGps({ ...truth.fix, time });
    if (time > 20) peak = Math.max(peak, Math.abs(state.roll - truth.roll / RAD));
  }
  assert.ok(peak < 3, `turn roll error ${peak}°`);
  assert.ok(a.getState(60).fusion.accepted > 20);
  assert.ok(covarianceIsPsd(a.getCovariance(), N));
});

test('no final-angle low-pass delays a real one-second roll', t => {
  const a = new Ahrs({ gravityAiding: false, gpsAiding: false }); t.after(() => a.dispose());
  a.setGyroBias([0, 0, 0], .05 * RAD);
  for (let i = 0; i <= 120; i++) a.update(quiet(i / 60));
  for (let i = 1; i <= 60; i++) {
    const time = i / 60, roll = 25 * RAD * time;
    a.update({ time: time + 2, gyro: [25 * RAD, 0, 0], specificForce: [0, -G * Math.sin(roll), -G * Math.cos(roll)] });
  }
  assert.ok(Math.abs(a.getState(3).roll - 25) < .6);
  assert.equal(DEFAULTS.gyroNoise, .015, 'keep the pinned PX4 noise parameter convention');
});
