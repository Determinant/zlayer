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
  assert.ok(bearing.read()! > 95 && bearing.read()! < 110, 'even a large GPS change is low-pass filtered');
  for (let time = 62; time <= 72; time++) bearing.observeGps(120, time);
  near(bearing.read(), 120, 3);
  bearing.reset(); bearing.observeGps(359, 0);
  for (let time = 1; time <= 8; time++) bearing.observeGps(4, time);
  assert.ok(bearing.read()! >= 0 && bearing.read()! < 4, 'cross north along the short arc');
  const held = bearing.read();
  bearing.observeGps(180, 0); assert.equal(bearing.read(), held);
  bearing.observeGps(1.5, 20); assert.equal(bearing.read(), 1.5, 'recovery seeds directly, even inside the deadband');
  bearing.reset(); assert.equal(bearing.read(), null);
  bearing.observeGps(240, 100); assert.equal(bearing.read(), 240);
});

for (const hz of [1, 5, 10]) {
  test(`cruise track fluctuations stay quiet while sustained corrections and turns follow at ${hz} Hz`, () => {
    const bearing = new TrackBearing();
    bearing.observeGps(90, 0);
    // Several degrees of noise persist for three seconds at a time, rather than
    // alternating unrealistically on every high-rate callback.
    for (let sample = 1; sample <= 60 * hz; sample++) {
      bearing.observeGps(90 + (Math.floor((sample - 1) / (3 * hz)) % 2 ? -5 : 5), sample / hz);
      assert.equal(bearing.read(), 90, 'cruise noise must not rotate the map');
    }
    for (let sample = 1; sample <= 15 * hz; sample++) bearing.observeGps(95, 60 + sample / hz);
    near(bearing.read(), 95, 3);
    // A continuous 3-degree/second turn must advance without waiting for a
    // single large step in GPS track.
    for (let sample = 1; sample <= 10 * hz; sample++) bearing.observeGps(95 + 3 * sample / hz, 75 + sample / hz);
    assert.ok(bearing.read()! > 112 && bearing.read()! <= 125, 'sustained turns stay within 13 degrees');
  });
}

for (const hz of [10, 20, 60]) {
  test(`sensor-assisted jitter is low-pass filtered while sustained turns follow at ${hz} Hz`, () => {
    const bearing = new TrackBearing();
    bearing.observeGps(90, 0);
    bearing.observeHeading({ degrees: 70, time: 0, frame: 1 }, 0);
    for (let sample = 1; sample <= 10 * hz; sample++) {
      const time = sample / hz;
      bearing.observeHeading({ degrees: 70 + 4 * Math.sin(time * Math.PI), time, frame: 1 }, time);
      if (sample % hz === 0) bearing.observeGps(90, time);
      assert.equal(bearing.read(), 90);
    }
    for (let sample = 1; sample <= 3 * hz; sample++) {
      const time = 10 + sample / hz;
      bearing.observeHeading({ degrees: 70 + 3 * sample / hz, time, frame: 1 }, time);
    }
    assert.ok(bearing.read()! > 93 && bearing.read()! < 99, 'sustained motion follows with display lag');
  });
}

test('relative AHRS turns preserve crosswind offset and reject gaps, jumps, stale readings and frame changes', () => {
  const bearing = new TrackBearing();
  bearing.observeGps(90, 0);
  const heading = (degrees: number, time: number, frame = 1, now = time) =>
    bearing.observeHeading({ degrees, time, frame }, now);
  heading(70, 0);
  for (let sample = 1; sample <= 8; sample++) heading(70 + sample, sample / 4);
  assert.ok(bearing.read()! > 92 && bearing.read()! < 98, 'track offset is preserved with smoothed relative rotation');
  const held = bearing.read();
  heading(100, 2.25, 2); assert.equal(bearing.read(), held, 'frame change discards the step');
  heading(130, 2.5, 2); assert.equal(bearing.read(), held, 'implausible jump is rejected');
  heading(132, 3.5, 2); assert.equal(bearing.read(), held, 'gap resets continuity');
  heading(134, 3.75, 2, 5); assert.equal(bearing.read(), held, 'stale heading is rejected');
  bearing.observeHeading(null, 4);
  heading(200, 4); assert.equal(bearing.read(), held);
});

test('delayed GPS corrections account for rotation since acquisition and sensor drift remains bounded', () => {
  const bearing = new TrackBearing(), timely = new TrackBearing();
  for (const filter of [bearing, timely]) {
    filter.observeGps(90, 0);
    for (let time = 0; time <= 2; time += .25) filter.observeHeading({ degrees: 70 + time * 4, time, frame: 1 }, time);
  }
  assert.ok(bearing.read()! > 92 && bearing.read()! < 98);
  const beforeCorrection = bearing.read();
  bearing.observeGps(94, 1); assert.equal(bearing.read(), beforeCorrection, 'delayed GPS cannot advance the display clock again');
  timely.observeGps(98, 2);
  for (let time = 2.25; time <= 4; time += .25) {
    for (const filter of [bearing, timely]) filter.observeHeading({ degrees: 70 + time * 4, time, frame: 1 }, time);
    near(bearing.read(), timely.read()!, .01);
  }
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
