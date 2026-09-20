import { covarianceIsPsd } from './helpers/ahrs-motion';
import { N } from '../src/layers/ahrs/estimator/state-layout';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Ahrs, DEFAULTS } from '../src/layers/ahrs/estimator/ahrs';
import { angleStd, initialState, releaseHeadingCovariance, restartNavigation, transferAlignmentCovariance } from '../src/layers/ahrs/estimator/eskf';
import { product, sandwich, skew, transpose } from '../src/layers/ahrs/estimator/linalg';
import { conjugate, fromEuler, rotate } from '../src/layers/ahrs/estimator/math';
import type { GpsFix } from '../src/layers/ahrs/estimator/types';
import { gravity as G, radians as RAD } from './helpers/ahrs-motion';

// Analytic, finite 90° coordinated turn: smooth roll-in/out and constant crosswind.
// No estimator quaternion/integration code generates the sensor observations.
function flight(time: number, turns: readonly number[] = [900]) {
  const speed = 50, rate = G * Math.tan(25 * RAD) / speed, ramp = 8;
  const plateau = Math.PI / 2 / rate - ramp;
  let yaw = 120 * RAD, yd = 0, ydd = 0;
  for (const start of turns) {
    const t = Math.max(0, time - start), up = Math.min(t, ramp);
    const hold = Math.max(0, Math.min(t - ramp, plateau));
    const down = Math.max(0, Math.min(t - ramp - plateau, ramp));
    yaw += rate * (up / 2 - ramp * Math.sin(Math.PI * up / ramp) / (2 * Math.PI) + hold +
      down / 2 + ramp * Math.sin(Math.PI * down / ramp) / (2 * Math.PI));
    yd += t < ramp ? rate * (1 - Math.cos(Math.PI * t / ramp)) / 2
      : t < ramp + plateau ? rate : rate * (1 + Math.cos(Math.PI * down / ramp)) / 2;
    ydd += t < ramp ? rate * Math.PI * Math.sin(Math.PI * t / ramp) / (2 * ramp)
      : t < ramp + plateau ? 0 : -rate * Math.PI * Math.sin(Math.PI * down / ramp) / (2 * ramp);
  }
  const roll = Math.atan(speed * yd / G), rd = speed / G * ydd / (1 + (speed * yd / G) ** 2);
  const cr = Math.cos(roll), sr = Math.sin(roll), north = speed * Math.cos(yaw) + 12, east = speed * Math.sin(yaw) - 9;
  return { roll: roll / RAD, yaw: yaw / RAD,
    sample: { time, gyro: [rd, yd * sr, yd * cr] as const,
      specificForce: [0, cr * speed * yd - sr * G, -sr * speed * yd - cr * G] as const },
    fix: { time, speed: Math.hypot(north, east), track: Math.atan2(east, north) / RAD,
      accuracy: 3, altitude: null, altitudeAccuracy: null } satisfies GpsFix,
  };
}
const difference = (a: number, b: number) => Math.atan2(Math.sin((a - b) * RAD), Math.cos((a - b) * RAD)) / RAD;

for (const scenario of [
  { name: 'precise GPS, manual heading', noise: .1, manual: true, delay: 0, interval: 1, sensors: false, loss: false, repeated: false },
  { name: 'precise GPS, blank heading', noise: .1, manual: false, delay: 0, interval: 1, sensors: false, loss: false, repeated: false },
  { name: 'browser GPS, noise, 1.8 s cadence and 1.1 s delivery delay', noise: 1.5, manual: true, delay: 1.1, interval: 1.8, sensors: true, loss: false, repeated: false },
  { name: 'GPS loss/recovery, changing yaw bias and a second long leg', noise: .1, manual: true, delay: .4, interval: 1, sensors: true, loss: true, repeated: true },
]) test(`heading recovery after 15 minutes straight: ${scenario.name}`, t => {
  const filter = new Ahrs({ gpsVelocityStd: scenario.noise }), queue: GpsFix[] = [];
  filter.setGyroBias([0, 0, 0], .05 * RAD);
  filter.update(flight(0).sample);
  if (scenario.manual) filter.alignHeading(120);
  const turns = scenario.repeated ? [900, 1800] : [900], end = turns.at(-1)! + 50, hz = 25;
  let nextGps = 1, maxTiltError = 0, maxTiltStd = 0, rejectionRun = 0, maxRejectionRun = 0;
  const acquisitions: number[] = [], recoveries: number[] = [], completionErrors: number[] = [];
  let previous = filter.getState(0);
  for (let i = 1; i <= end * hz; i++) {
    const time = i / hz, truth = flight(time, turns), noise = scenario.sensors ? Math.sin(time * 7.13) : 0;
    const bias = scenario.repeated && time >= 1000 ? -.12 : .08;
    filter.update({ ...truth.sample,
      gyro: [truth.sample.gyro[0] + noise * .02 * RAD, truth.sample.gyro[1] - noise * .02 * RAD, truth.sample.gyro[2] + bias * RAD],
      specificForce: [truth.sample.specificForce[0] + noise * .03,
        truth.sample.specificForce[1] - noise * .03, truth.sample.specificForce[2] + noise * .03] });
    if (time >= nextGps - 1e-6) {
      if (!scenario.loss || time < 850 || time >= 895) queue.push({ ...truth.fix,
        speed: truth.fix.speed + (scenario.sensors ? scenario.noise * .3 * Math.sin(time * .73) : 0),
        track: truth.fix.track + (scenario.sensors ? scenario.noise * .3 * Math.cos(time * .91) : 0),
        altitude: scenario.sensors ? 1000 + .5 * Math.sin(time * .2) : null,
        altitudeAccuracy: scenario.sensors ? 5 : null });
      nextGps += scenario.interval;
    }
    while (queue.length && queue[0]!.time <= time - scenario.delay + 1e-6) {
      const before = filter.getState(time).fusion.rejected;
      filter.updateGps(queue.shift()!);
      rejectionRun = filter.getState(time).fusion.rejected > before ? rejectionRun + 1 : 0;
      maxRejectionRun = Math.max(maxRejectionRun, rejectionRun);
    }
    const state = filter.getState(time);
    if (state.headingStatus === 'recovering' && previous.headingStatus === 'tracking') recoveries.push(time);
    if (state.headingStatus === 'tracking' && previous.headingStatus !== 'tracking') {
      acquisitions.push(time);
      assert.equal(state.headingReference, 'gps-inertial', 'manual input is never reapplied');
      assert.equal(state.gpsAiding, false, 'alignment observations are not also velocity updates');
      assert.ok(state.fusion.accepted >= previous.fusion.accepted, 'diagnostic counts survive alignment');
    }
    const error = Math.hypot(state.roll - truth.roll, state.pitch);
    maxTiltError = Math.max(maxTiltError, error);
    maxTiltStd = Math.max(maxTiltStd, state.tiltStd);
    assert.ok(error < 3 * state.tiltStd + .1, `tilt error ${error} inconsistent with σ ${state.tiltStd} at ${time}`);
    assert.notEqual(state.status, 'interrupted', `interruption at ${time}: ${state.reason}`);
    if (time === 840) {
      assert.equal(state.headingStatus, scenario.manual ? 'recovering' : 'acquiring');
      assert.equal(state.headingReference, scenario.manual ? 'manual-true' : 'relative', 'source is history, not validity');
      assert.equal(state.attitudeStd[2], Infinity, 'absolute yaw is unknown while relative tilt remains useful');
      assert.equal(state.tiltAiding, true);
    }
    for (const turn of turns) if (time === turn + 35) {
      const yawError = Math.abs(difference(state.yaw, truth.yaw));
      completionErrors.push(yawError);
      assert.equal(state.headingStatus, 'tracking');
      assert.equal(state.gpsAiding, true);
      assert.ok(yawError < 5, `heading error ${yawError} at ${time}`);
      assert.ok(yawError < 3 * state.attitudeStd[2]);
      assert.ok(Math.abs(difference(state.yaw, truth.fix.track)) > 5, 'crosswind track must not replace nose heading');
    }
    previous = state;
  }
  t.diagnostic(JSON.stringify({ recoveries, acquisitions, completionErrors, maxTiltError, maxTiltStd, maxRejectionRun }));
  assert.equal(acquisitions.length, turns.length);
  assert.equal(recoveries.length, scenario.manual ? turns.length : 0);
  acquisitions.forEach((time, i) => assert.ok(time > turns[i]! && time < turns[i]! + 30));
  assert.ok(maxTiltError < 3, `maximum tilt error ${maxTiltError}`);
  assert.ok(maxTiltStd < 8, `maximum tilt uncertainty ${maxTiltStd}`);
  assert.ok(maxRejectionRun < 3, 'recovery must not stall behind local correction limits');
  assert.ok(covarianceIsPsd(filter.getCovariance(), N));
});

test('an isolated GPS outlier does not discard a working alignment', () => {
  const filter = new Ahrs({ gpsVelocityStd: .1 });
  filter.setGyroBias([0, 0, 0], .05 * RAD);
  filter.update(flight(0, [3]).sample);
  filter.alignHeading(120);
  for (let i = 1; i <= 40 * 50; i++) {
    const time = i / 50, truth = flight(time, [3]);
    filter.update(truth.sample);
    if (i % 50 === 0) filter.updateGps({ ...truth.fix, track: truth.fix.track + (time === 12 ? 90 : 0) });
    assert.equal(filter.getState(time).headingStatus, 'tracking');
  }
  const state = filter.getState(40);
  assert.equal(state.fusion.rejected, 1);
  assert.equal(state.headingReference, 'manual-true');
  assert.ok(Math.abs(difference(state.yaw, flight(40, [3]).yaw)) < 1);
});

for (const delay of [0, 1.1]) test(`altitude corrections do not stall heading recovery (${delay}s GPS delay)`, () => {
  const filter = new Ahrs({ gpsVelocityStd: .1, initialHeadingStd: 10 });
  const queue: GpsFix[] = [];
  filter.setGyroBias([0, 0, 0], .05 * RAD);
  filter.update(flight(0, [3]).sample);
  filter.alignHeading(210); // Deliberately wrong 90°, with an overconfident prior.
  let recovered: number | null = null, maxTiltError = 0;
  for (let i = 1; i <= 60 * 50; i++) {
    const time = i / 50, truth = flight(time, [3]);
    filter.update(truth.sample);
    if (i % 50 === 0) queue.push({ ...truth.fix, altitude: 1000, altitudeAccuracy: 5 });
    while (queue.length && queue[0]!.time <= time - delay + 1e-6) filter.updateGps(queue.shift()!);
    const state = filter.getState(time);
    if (state.headingReference === 'gps-inertial') recovered ??= time;
    maxTiltError = Math.max(maxTiltError, Math.hypot(state.roll - truth.roll, state.pitch));
    assert.notEqual(state.status, 'interrupted');
  }
  const state = filter.getState(60);
  assert.ok(recovered !== null && recovered < 25, `recovery at ${recovered}`);
  assert.ok(state.altitudeFusion.accepted > 30, 'independent altitude aid continues');
  assert.ok(state.fusion.rejected < 20, 'recovery cannot stall for the remainder of the turn');
  assert.ok(maxTiltError < 2);
  assert.ok(Math.abs(difference(state.yaw, flight(60, [3]).yaw)) < 2);
  assert.ok(covarianceIsPsd(filter.getCovariance(), N));
});

for (const { offset, std } of [{ offset: 60, std: 10 }, { offset: 90, std: 10 }, { offset: 150, std: 10 }, { offset: 90, std: 29 }]) {
  test(`fresh rejected GPS motion can replace a wrong ${offset}° heading with ${std}° prior uncertainty`, () => {
    const filter = new Ahrs({ gpsVelocityStd: .1, initialHeadingStd: std });
    filter.setGyroBias([0, 0, 0], .05 * RAD);
    filter.update(flight(0, [3]).sample);
    filter.alignHeading(120 + offset);
    let alignedAt: number | undefined, released = false, maximumTiltError = 0;
    for (let i = 1; i <= 45 * 50; i++) {
      const time = i / 50, truth = flight(time, [3]);
      filter.update(truth.sample);
      if (i % 50 === 0) {
        const before = filter.getState(time);
        filter.updateGps(truth.fix);
        const after = filter.getState(time);
        if (before.headingStatus === 'tracking' && after.headingStatus === 'recovering') {
          released = true;
          assert.equal(after.headingReason, 'GPS attitude correction exceeds tracking range');
          assert.deepEqual(after.quaternion, before.quaternion, 'releasing heading must not move the attitude');
          assert.deepEqual(after.bias, before.bias);
          assert.deepEqual(after.accelBias, before.accelBias);
          assert.ok(Math.abs(after.tiltStd - before.tiltStd) < 1e-8);
          assert.equal(after.attitudeStd[2], Infinity);
        }
        if (after.headingReference === 'gps-inertial' && alignedAt === undefined) {
          alignedAt = time;
          assert.equal(after.gpsAiding, false, 'rejected measurements used for alignment are not fused again');
        }
      }
      const state = filter.getState(time);
      maximumTiltError = Math.max(maximumTiltError, Math.hypot(state.roll - truth.roll, state.pitch));
      assert.notEqual(state.status, 'interrupted');
    }
    const state = filter.getState(45);
    assert.ok(alignedAt !== undefined && alignedAt < 25);
    assert.equal(released, std === 29, 'model-limit recovery is distinct from a fresh fit of rejected innovations');
    assert.ok(maximumTiltError < 2);
    assert.ok(Math.abs(difference(state.yaw, flight(45, [3]).yaw)) < 2);
    assert.ok(covarianceIsPsd(filter.getCovariance(), N));
  });
}

test('frame changes preserve tilt/bias marginals and correlations instead of replacing them with calibration priors', () => {
  const previous = initialState(fromEuler(.4, -.3, 2), [.001, -.002, .003], [.1, -.1, .05], true, DEFAULTS);
  // A dense positive-definite attitude/bias covariance with nonzero cross terms.
  const L = new Float64Array(81);
  for (let i = 0; i < 9; i++) for (let j = 0; j <= i; j++) L[i * 9 + j] = i === j ? .1 + i * .01 : .015 * Math.sin(i + 2 * j);
  const marginal = product(L, transpose(L, 9, 9), 9, 9, 9);
  for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) previous.P[(i + 6) * N + j + 6] = marginal[i * 9 + j]!;
  const down = rotate(conjugate(previous.q), [0, 0, 1]), D = skew(down), observable = new Float64Array(81);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) observable[i * 9 + j] = D[i * 3 + j]!;
  for (let i = 3; i < 9; i++) observable[i * 9 + i] = 1;
  const before = sandwich(observable, marginal, 9, 9);
  for (const reference of ['relative', 'aligned']) {
    const next = restartNavigation(previous, previous.q, DEFAULTS);
    if (reference === 'relative') releaseHeadingCovariance(previous, next);
    else transferAlignmentCovariance(previous, next, 7);
    const transferred = new Float64Array(81);
    for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) transferred[i * 9 + j] = next.P[(i + 6) * N + j + 6]!;
    const after = sandwich(observable, transferred, 9, 9);
    before.forEach((value, i) => assert.ok(Math.abs(value - after[i]!) < 1e-12, `${reference}, covariance ${i}`));
    assert.deepEqual(next.q, previous.q);
    assert.deepEqual(next.bg, previous.bg);
    assert.deepEqual(next.ba, previous.ba);
    if (reference === 'aligned') {
      assert.ok(Math.abs(angleStd(next)[2] - 7) < 1e-6);
      assert.ok(covarianceIsPsd(next.P, N));
    }
  }
});
