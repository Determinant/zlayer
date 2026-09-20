import { covarianceIsPsd } from './helpers/ahrs-motion';
import { N } from '../src/layers/ahrs/estimator/state-layout';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Ahrs } from '../src/layers/ahrs/estimator/ahrs';
import { FlightAlignment } from '../src/layers/ahrs/estimator/flight-alignment';
import type { GpsFix } from '../src/layers/ahrs/estimator/types';

import { gravity, radians, turn } from './helpers/ahrs-motion';

for (const hz of [30, 50, 60]) test(`${hz} Hz ESKF follows a crosswind turn with delayed browser GPS and healthy covariance`, t => {
  const filter = new Ahrs();
  const queue: GpsFix[] = [];
  filter.update(turn(0).sample); filter.alignHeading(0);
  let maximumRollError = 0;
  for (let i = 1; i <= 35 * hz; i++) {
    const truth = turn(i / hz);
    filter.update(truth.sample);
    if (i % (hz / 2) === 0) queue.push(truth.fix);
    while (queue.length && queue[0]!.time <= truth.sample.time - .3) filter.updateGps(queue.shift()!);
    const state = filter.getState(truth.sample.time);
    maximumRollError = Math.max(maximumRollError, Math.abs(state.roll - truth.roll / radians));
    assert.notEqual(state.status, 'interrupted');
  }
  assert.ok(maximumRollError < .5, `roll error ${maximumRollError}°`);
  const state = filter.getState(35);
  assert.equal(state.gpsAiding, true);
  assert.ok(Math.abs(state.pitch) < .5);
  assert.ok(state.fusion.accepted > 60);
  assert.equal(state.fusion.rejected, 0);
  assert.ok(covarianceIsPsd(filter.getCovariance(), N), 'covariance remains positive semidefinite');
  t.diagnostic(`Maximum roll error at ${hz} Hz: ${maximumRollError.toFixed(4)}°; final pitch: ${state.pitch.toFixed(4)}°`);
});

for (const heading of [0, 120, 270]) test(`GPS motion establishes ${heading} degree heading and aids attitude without manual alignment`, t => {
  const filter = new Ahrs(), queue: GpsFix[] = [];
  filter.setGyroBias([0, 0, 0], .2 * radians);
  filter.update(turn(0, heading).sample);
  let alignedAt: number | undefined, maximumRollError = 0;
  for (let i = 1; i <= 45 * 50; i++) {
    const truth = turn(i / 50, heading);
    filter.update(heading === 120 ? { ...truth.sample,
      gyro: [truth.sample.gyro[0] + .001, truth.sample.gyro[1] - .001, truth.sample.gyro[2] + .001],
      specificForce: [truth.sample.specificForce[0] + .03, truth.sample.specificForce[1] - .04, truth.sample.specificForce[2] + .02],
    } : truth.sample);
    if (i % 25 === 0) queue.push(heading === 120 ? { ...truth.fix,
      speed: truth.fix.speed + .5 * Math.sin(i / 25 * 1.83), track: truth.fix.track + .3 * Math.cos(i / 25 * .997),
    } : truth.fix);
    while (queue.length && queue[0]!.time <= truth.sample.time - .3) filter.updateGps(queue.shift()!);
    const state = filter.getState(truth.sample.time);
    if (state.headingReference === 'gps-inertial') alignedAt ??= truth.sample.time;
    maximumRollError = Math.max(maximumRollError, Math.abs(state.roll - truth.roll / radians));
    assert.notEqual(state.status, 'interrupted');
  }
  const state = filter.getState(45), truth = turn(45, heading);
  assert.equal(state.headingReference, 'gps-inertial');
  assert.equal(state.gpsAiding, true);
  assert.ok(maximumRollError < (heading === 120 ? 3 : 1), `roll error ${maximumRollError}`);
  const error = Math.atan2(Math.sin(state.yaw * radians - truth.yaw), Math.cos(state.yaw * radians - truth.yaw)) / radians;
  assert.ok(Math.abs(error) < 5, `heading error ${error}`);
  assert.ok(Math.abs(state.pitch) < (heading === 120 ? 3 : 1));
  assert.ok(covarianceIsPsd(filter.getCovariance(), N));
  t.diagnostic(`Aligned after ${alignedAt}s; heading error ${error.toFixed(2)}°`);
});

for (const quality of ['slow', 'inaccurate', 'estimated', 'noise', 'uncertain tilt'] as const) {
  test(`automatic GPS motion alignment rejects ${quality} velocity observations`, () => {
    const filter = new Ahrs(quality === 'uncertain tilt' ? { initialTiltStd: 180, gravityAiding: false } : {});
    filter.setGyroBias([0, 0, 0], .2 * radians);
    filter.update(turn(0).sample);
    for (let i = 1; i <= 35 * 50; i++) {
      const truth = turn(i / 50);
      filter.update(truth.sample);
      if (i % 50 === 0) filter.updateGps({ ...truth.fix,
        ...(quality === 'slow' ? { speed: 5 } : quality === 'inaccurate' ? { accuracy: 100 }
          : quality === 'estimated' ? { estimated: true } : quality === 'noise' ? { track: (i / 50 % 2) * 180 } : {}),
      });
    }
    assert.equal(filter.getState(35).headingReference, 'relative');
    if (quality === 'inaccurate' || quality === 'estimated') assert.equal(filter.getState(35).gpsAiding, false);
    assert.equal(filter.getState(35).attitudeStd[2], Infinity);
  });
}

test('speed, steady acceleration, and receiver noise cannot invent an absolute heading', () => {
  for (const acceleration of [0, .8]) {
    const filter = new Ahrs();
    filter.setGyroBias([0, 0, 0], .2 * radians);
    filter.update({ time: 0, gyro: [0, 0, 0], specificForce: [0, 0, -gravity] });
    for (let i = 1; i <= 30 * 50; i++) {
      const time = i / 50;
      filter.update({ time, gyro: [0, 0, 0], specificForce: [acceleration, 0, -gravity] });
      if (i % 25 === 0) filter.updateGps({ time, speed: 50 + acceleration * time + .5 * Math.sin(i),
        track: 120 + .5 * Math.cos(i), accuracy: 5, altitude: null, altitudeAccuracy: null });
    }
    const state = filter.getState(30);
    assert.equal(state.headingReference, 'relative');
    assert.equal(state.attitudeStd[2], Infinity);
    assert.ok(state.fusion.accepted > 0, 'yaw-independent GPS evidence can aid without establishing north');
  }
});

test('calibration gate requires vertical evidence unless the host explicitly supplies pilot confirmation', () => {
  const strict = new FlightAlignment();
  const confirmed = new FlightAlignment({ requireVerticalEvidence: false });
  const climbing = new FlightAlignment();
  for (let i = 0; i <= 500; i++) {
    const time = i / 50;
    for (const gate of [strict, confirmed, climbing]) {
      gate.observeImu({ time, gyro: [0, 0, 0], specificForce: [0, 0, -gravity] });
      if (i % 50 === 0) gate.observeGps({ time, accuracy: 5, speed: 50, track: 0,
        ...(gate === climbing ? { velocityNed: [50, 0, -3] as const } : {}) });
    }
  }
  assert.equal(strict.snapshot(10).reason, 'vertical-evidence-unavailable');
  assert.equal(confirmed.snapshot(10).reason, 'ready');
  assert.equal(confirmed.snapshot(10).solution!.gpsVerified, true);
  assert.equal(climbing.snapshot(10).reason, 'vertical-motion');
  confirmed.observeImu({ time: 11, gyro: [0, 0, 0], specificForce: [0, 0, -gravity] });
  assert.equal(confirmed.snapshot(11).reason, 'collecting-imu', 'gaps restart the observation window');
});

test('unaided alignment is explicit and does not weaken the default GPS evidence gate', () => {
  const strict = new FlightAlignment({ requireVerticalEvidence: false });
  const unaided = new FlightAlignment({ requireVerticalEvidence: false, allowUnaided: true });
  for (const gate of [strict, unaided]) for (let i = 0; i <= 500; i++) {
    gate.observeImu({ time: i / 50, gyro: [.001, 0, 0], specificForce: [0, 0, -gravity] });
  }
  assert.equal(strict.snapshot(10).reason, 'collecting-gps');
  assert.equal(strict.snapshot(10).solution, null);
  const reference = unaided.snapshot(10);
  assert.equal(reference.reason, 'ready');
  assert.equal(reference.solution!.gpsVerified, false);
  assert.ok(Math.abs(reference.solution!.gyroBias[0] - .001) < 1e-10);
  assert.equal(unaided.snapshot(11).solution, null, 'stale IMU data cannot initialize even a reference attitude');
});

test('a partial GPS window showing acceleration blocks unaided alignment', () => {
  const gate = new FlightAlignment({ requireVerticalEvidence: false, allowUnaided: true });
  for (let i = 0; i <= 500; i++) {
    gate.observeImu({ time: i / 50, gyro: [0, 0, 0], specificForce: [0, 0, -gravity] });
    if (i >= 250 && i % 50 === 0) gate.observeGps({ time: i / 50, speed: 50 + i / 50, track: 90, accuracy: 5 });
  }
  assert.equal(gate.snapshot(10).reason, 'gps-unstable');
  assert.equal(gate.snapshot(10).solution, null);
});

test('partial and mixed GPS evidence cannot hide a measured climb or descent', () => {
  for (const down of [-5, 5]) for (const start of [0, 5, 10]) {
    const gate = new FlightAlignment({ requireVerticalEvidence: false, allowUnaided: true });
    for (let i = 0; i <= 500; i++) {
      const time = i / 50;
      gate.observeImu({ time, gyro: [0, 0, 0], specificForce: [0, 0, -gravity] });
      if (time >= start && i % 50 === 0) gate.observeGps({ time, speed: 50, track: 0, accuracy: 5,
        ...(time === start ? { velocityNed: [50, 0, down] as const } : {}) });
    }
    assert.equal(gate.snapshot(10).reason, 'vertical-motion', `down=${down}, GPS starts at ${start}s`);
    assert.equal(gate.snapshot(10).solution, null);
  }
});

test('GPS verification at the window boundary is independent of the clock origin', () => {
  for (const start of [0, .123]) {
    const gate = new FlightAlignment({ allowUnaided: true });
    for (let i = 1; i <= 490; i++) {
      const time = start + i / 50;
      if (i % 50 === 0) gate.observeGps({ time, speed: 50, track: 90, accuracy: 5, altitude: 1000, altitudeAccuracy: 10 });
      gate.observeImu({ time, gyro: [0, 0, 0], specificForce: [0, 0, -gravity] });
    }
    assert.equal(gate.snapshot(start + 9.8).solution?.gpsVerified, true);
  }
});
