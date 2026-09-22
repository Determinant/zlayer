import assert from 'node:assert/strict';
import test from 'node:test';
import { HeadingReference } from '../src/layers/ahrs/heading-reference';
import { Ahrs } from '../src/layers/ahrs/estimator/ahrs';
import { fromEuler, G, RAD } from '../src/layers/ahrs/estimator/math';
import type { Attitude, ImuSample } from '../src/layers/ahrs/estimator/types';

const base = new Ahrs().update({ time: 0, gyro: [0, 0, 0], specificForce: [0, 0, -G] });
const attitude = (yaw: number, headingStatus: Attitude['headingStatus'] = 'acquiring'): Attitude =>
  ({ ...base, yaw, quaternion: fromEuler(0, 0, yaw * RAD), headingStatus });
const sample = (time: number, rate = 10): ImuSample => ({ time, gyro: [0, 0, rate * RAD], specificForce: [0, 0, -G] });
const near = (actual: number, expected: number, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

test('GPS seeds north once and calibrated gyro motion carries heading through north without more fixes', () => {
  const reference = new HeadingReference();
  reference.observeImu(sample(0), attitude(0), 0);
  assert.equal(reference.read(0), null, 'REL until an absolute reference exists');
  reference.observeGps(0, 359, 0, attitude(0));
  near(reference.read(0)!.degrees, 359);
  reference.observeImu(sample(.2), attitude(2), .2);
  near(reference.read(.2)!.degrees, 1);
  assert.equal(reference.read(.2)!.source, 'gps', 'the track-based assumption remains explicit');
  for (let i = 3; i <= 50; i++) reference.observeImu(sample(i / 10), attitude(i), i / 10);
  near(reference.read(5)!.degrees, 49, 1e-5);
});

test('delayed and slightly future GPS fixes match gyro motion at acquisition time', () => {
  const reference = new HeadingReference();
  reference.observeImu(sample(0), attitude(0), 0);
  reference.observeGps(0, 90, 0, attitude(0));
  for (let i = 1; i <= 10; i++) reference.observeImu(sample(i / 10), attitude(i), i / 10);
  reference.observeGps(.55, 95.5, 1, attitude(10));
  near(reference.read(1)!.degrees, 100);
  near(reference.read(1.05)!.degrees, 100, 1e-5);
  reference.observeGps(1.1, 101, 1.1, attitude(10));
  reference.observeImu(sample(1.1), attitude(11), 1.1);
  near(reference.read(1.1)!.degrees, 101, 1e-5);
  reference.observeGps(1.1, 220, 1.1, attitude(11));
  reference.observeGps(.9, 230, 1.1, attitude(11));
  near(reference.read(1.2)!.degrees, 101, 1e-5);
});

test('GPS jitter settles gradually along the shortest arc and display reads are pure', () => {
  const reference = new HeadingReference();
  reference.observeGps(0, 359, 0, null);
  reference.observeGps(1, 1, 1, null);
  near(reference.read(1)!.degrees, 359);
  const next = reference.read(1.1)!;
  assert.ok(next.degrees > 359 && next.degrees < 359.1);
  assert.deepEqual(reference.read(1.1), next);
  assert.deepEqual(reference.read(100), reference.read(4), 'expired corrections stop changing the card');
});

test('navigation-frame acquisition is smoothed and recovery keeps the geographic reference', () => {
  const reference = new HeadingReference();
  reference.observeImu(sample(0, 0), attitude(0), 0);
  reference.observeGps(0, 75, 0, attitude(0));
  reference.observeImu(sample(.1, 0), attitude(150, 'tracking'), .1);
  near(reference.read(.1)!.degrees, 75, 1e-5);
  assert.ok(reference.read(.2)!.degrees > 75 && reference.read(.2)!.degrees < 85);
  const held = reference.read(4)!.degrees;
  reference.observeImu(sample(4, 10), attitude(150, 'recovering'), 4);
  near(reference.read(4)!.degrees, held, 1e-5);
  reference.observeImu(sample(4.1, 10), attitude(151, 'recovering'), 4.1);
  near(reference.read(4.1)!.degrees, held + 1, 1e-5);
  reference.reset();
  assert.equal(reference.read(5), null);
});

test('trusted heading takes precedence over GPS track and an explicit reset clears all history', () => {
  const reference = new HeadingReference();
  reference.reset(75, 0);
  reference.observeImu(sample(0, 0), attitude(75, 'tracking'), 0);
  reference.observeGps(0, 120, 0, attitude(75, 'tracking'));
  near(reference.read(1)!.degrees, 75);
  reference.reset();
  reference.observeGps(0, 90, 0, null);
  near(reference.read(0)!.degrees, 90);
});

test('GPS arriving during a motion pause can still establish an estimated heading', () => {
  const reference = new HeadingReference();
  reference.observeImu(sample(0), attitude(0), 0);
  reference.observeGps(1, 90, 1, { ...attitude(0), status: 'stale' });
  near(reference.read(1)!.degrees, 90);
  reference.observeImu(sample(2), attitude(0, 'recovering'), 2);
  near(reference.read(2)!.degrees, 90, 1e-5);
  reference.observeImu(sample(2.1), attitude(1, 'recovering'), 2.1);
  near(reference.read(2.1)!.degrees, 91, 1e-5);
});
