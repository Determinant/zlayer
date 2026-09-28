import assert from 'node:assert/strict';
import test from 'node:test';
import { TrackBearing } from '../src/workspace/map/track-bearing';

const near = (actual: number | null, expected: number, tolerance = .1) =>
  assert.ok(actual !== null && Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

test('track-up holds small GPS noise, follows sustained turns, wraps north and resets on loss', () => {
  const bearing = new TrackBearing();
  bearing.observeGps(90, 0);
  for (let time = 1; time <= 60; time++) bearing.observeGps(90 + (time % 2 ? .8 : -.8), time);
  assert.equal(bearing.read(), 90);
  bearing.observeGps(120, 61);
  near(bearing.read(), 120, 2);
  bearing.reset(); bearing.observeGps(359, 0); bearing.observeGps(2, 1);
  near(bearing.read(), .46);
  bearing.observeGps(180, 0); near(bearing.read(), .46);
  bearing.reset(); assert.equal(bearing.read(), null);
  bearing.observeGps(240, 100); assert.equal(bearing.read(), 240);
});

test('relative AHRS turns preserve crosswind offset and reject gaps, jumps, stale readings and frame changes', () => {
  const bearing = new TrackBearing();
  bearing.observeGps(90, 0);
  const heading = (degrees: number, time: number, frame = 1, now = time) =>
    bearing.observeHeading({ degrees, time, frame }, now);
  heading(70, 0); heading(72, .25); near(bearing.read(), 92);
  heading(74, .5); near(bearing.read(), 94);
  heading(76, .75, 2); near(bearing.read(), 94, .01);
  heading(78, 1, 2); near(bearing.read(), 96);
  heading(100, 1.25, 2); near(bearing.read(), 96, .01);
  heading(102, 2.25, 2); near(bearing.read(), 96, .01);
  heading(104, 2.5, 2, 4); near(bearing.read(), 96, .01);
  bearing.observeHeading(null, 4);
  heading(200, 4); near(bearing.read(), 96, .01);
});

test('delayed GPS corrections account for rotation since acquisition and sensor drift remains bounded', () => {
  const bearing = new TrackBearing();
  bearing.observeGps(90, 0);
  for (let time = 0; time <= 2; time += .25) bearing.observeHeading({ degrees: 70 + time * 4, time, frame: 1 }, time);
  near(bearing.read(), 98);
  bearing.observeGps(94, 1); near(bearing.read(), 98, .01);
  for (let time = 2.25; time <= 4; time += .25) bearing.observeHeading({ degrees: 70 + time * 4, time, frame: 1 }, time);
  assert.ok(bearing.read()! <= 109, 'sensor heading cannot drift over 15 degrees from the last GPS track');
  const held = bearing.read();
  bearing.observeHeading({ degrees: 90, time: 4.25, frame: 1 }, 4.25);
  assert.equal(bearing.read(), held, 'no inertial coasting after GPS is too old');
});

test('sensor bounds cannot turn a damped GPS correction into a heading jump', () => {
  const bearing = new TrackBearing();
  bearing.observeGps(90, 0);
  bearing.observeHeading({ degrees: 70, time: 0, frame: 1 }, 0);
  bearing.observeHeading({ degrees: 70, time: .25, frame: 1 }, .25);
  bearing.observeGps(170, .25);
  const before = bearing.read();
  bearing.observeHeading({ degrees: 70, time: .5, frame: 1 }, .5);
  assert.equal(bearing.read(), before, 'a stationary sensor adds no motion when GPS is still settling');
});
