import assert from 'node:assert/strict';
import test from 'node:test';
import { destination, estimateTurnRate, projectedTrack, smoothMotion } from '../src/layers/ownship/position';
import { distanceMeters, GPS_STALE_MS, readGpsFix, type GpsFix } from '../src/core/gps/position';
import { ownshipGeometry } from '../src/layers/ownship/geometry';

const now = 1_800_000_000_000;
const clock = { timestamp: now, time: 100 };
function position(coords: Partial<GeolocationCoordinates> = {}, timestamp = now): GeolocationPosition {
  return { timestamp, coords: { latitude: 37, longitude: -122, accuracy: 5,
    heading: null, speed: null, altitude: null, altitudeAccuracy: null, ...coords } } as GeolocationPosition;
}

test('120 knots projects two nautical miles in one minute along true track, including zero degrees', () => {
  for (const heading of [0, 90, 180, 270]) {
    const fix = readGpsFix(position({ heading, speed: 120 * 1852 / 3600 }), null, clock)!;
    const trace = projectedTrack(fix);
    assert.equal(trace.length, 13);
    assert.deepEqual(trace[0], fix.coordinates);
    assert.ok(Math.abs(distanceMeters(fix.coordinates, trace.at(-1)!) - 2 * 1852) < 0.01);
    if (heading === 0) assert.ok(trace.at(-1)![1] > 37);
    if (heading === 90) assert.ok(trace.at(-1)![0] > -122);
    if (heading === 180) assert.ok(trace.at(-1)![1] < 37);
    if (heading === 270) assert.ok(trace.at(-1)![0] < -122);
  }
});

test('unknown velocity, stopped aircraft, noisy or inaccurate fixes never invent a projection', () => {
  const previous = readGpsFix(position({}, now - 2000), null, clock)!;
  for (const coords of [{}, { speed: 0, heading: 90 }, { speed: .5, heading: 90 },
    { speed: NaN, heading: NaN }, { speed: -10, heading: 361 }, { accuracy: 5000, speed: 60, heading: 90 }]) {
    const fix = readGpsFix(position(coords), previous, clock)!;
    assert.equal(fix.track, null);
    assert.deepEqual(projectedTrack(fix), []);
  }
  const headingOnly = readGpsFix(position({ heading: 90 }), null, clock)!;
  assert.equal(headingOnly.track, 90);
  assert.deepEqual(projectedTrack(headingOnly), [], 'unknown groundspeed is not zero or an assumed cruise speed');
});

test('missing velocity is estimated from significant recent movement but zero reported speed wins', () => {
  const previous = readGpsFix(position({}, now - 2000), null, clock)!;
  const [longitude, latitude] = destination(previous.coordinates, 90, 120);
  const fix = readGpsFix(position({ longitude, latitude }), previous, clock)!;
  assert.ok(Math.abs(fix.track! - 90) < .002);
  assert.ok(Math.abs(fix.speed! - 60) < .0001);
  assert.equal(fix.estimated, true);
  const stopped = readGpsFix(position({ longitude, latitude, speed: 0 }), previous, clock)!;
  assert.equal(stopped.track, null);
  assert.equal(stopped.speed, 0);
  const stale = readGpsFix(position({ longitude, latitude }), { ...previous, timestamp: now - 30_000, time: 70 }, clock)!;
  assert.equal(stale.track, null);
  const jitter = readGpsFix(position({ longitude: -122.00001 }), previous, clock)!;
  assert.equal(jitter.track, null);
});

test('invalid, expired, future and out-of-order positions are ignored', () => {
  const previous = readGpsFix(position({}, now - 1000), null, clock)!;
  for (const sample of [position({ latitude: 91 }), position({ longitude: -181 }), position({ accuracy: -1 }),
    position({ latitude: NaN }), position({}, now - GPS_STALE_MS), position({}, now + 100_000),
    position({}, previous.timestamp), position({}, now - 2000)]) {
    assert.equal(readGpsFix(sample, previous, clock), null);
  }
});

test('GPS time retains acquisition age and tolerates small clock rounding without future-dating the fix', () => {
  const delayed = readGpsFix(position({}, now - 750), null, clock)!;
  assert.equal(delayed.timestamp, now - 750);
  assert.equal(delayed.time, 99.25);
  const rounded = readGpsFix(position({}, now + 500), null, clock)!;
  assert.equal(rounded.timestamp, now + 500);
  assert.equal(rounded.time, 100);
  assert.equal(readGpsFix(position({}, now + 1001), null, clock), null);
  assert.equal(readGpsFix(position(), { ...delayed, time: 101 }, clock), null,
    'a normalized observation cannot move backward even when its epoch timestamp increases');
});

test('shared GPS retains altitude in meters, including sea level and below, without inventing missing height', () => {
  for (const altitude of [0, -120, 3048]) {
    const fix = readGpsFix(position({ altitude, altitudeAccuracy: 10 }), null, clock)!;
    assert.equal(fix.altitude, altitude);
    assert.equal(fix.altitudeAccuracy, 10);
  }
  for (const altitude of [null, NaN, Infinity]) {
    const fix = readGpsFix(position({ altitude, altitudeAccuracy: -5 }), null, clock)!;
    assert.equal(fix.altitude, null);
    assert.equal(fix.altitudeAccuracy, null);
  }
});

test('dateline and high-latitude projections stay short and finite', () => {
  for (const [longitude, latitude, heading] of [[179.99, 60, 90], [-179.99, 60, 270], [40, 89.9, 45]] as const) {
    const fix = readGpsFix(position({ longitude, latitude, heading, speed: 100 }), null, clock)!;
    const trace = projectedTrack(fix);
    assert.ok(trace.flat().every(Number.isFinite));
    assert.ok(Math.abs(trace.at(-1)![0] - longitude!) < 90);
    assert.ok(Math.abs(distanceMeters(fix.coordinates, trace.at(-1)!) - 6000) < .001);
  }
});

test('turn estimates unwrap north and stay consistent with irregular, frequent GPS updates', () => {
  for (const rate of [-1, 1]) {
    const history: GpsFix[] = [];
    for (const elapsed of [0, 100, 300, 800, 1000, 1700, 2400, 3000, 3800, 4700, 6000]) {
      const heading = (360 + rate * (elapsed / 1000 - 1.5)) % 360;
      const fix = readGpsFix(position({ heading, speed: 60 }, now - 6000 + elapsed), null, clock)!;
      const estimate = estimateTurnRate(fix, history);
      if (elapsed < 3000) assert.equal(estimate, null);
      else assert.ok(Math.abs(estimate! - rate) < 1e-9);
      history.push(fix);
    }
  }
});

test('turn estimates reject discontinuities and unavailable motion, and suppress small track jitter', () => {
  const origin = readGpsFix(position({ heading: 90, speed: 60 }, now - 2000), null, clock)!;
  const current = readGpsFix(position({ heading: 92, speed: 60 }), null, clock)!;
  assert.equal(estimateTurnRate(current, []), null);
  for (const change of [{ track: null }, { speed: null }, { speed: 0 }, { accuracy: 101 }, { estimated: true },
    { timestamp: now - 2600 }, { track: 180 }]) {
    assert.equal(estimateTurnRate(current, [{ ...origin, ...change }]), null);
  }
  for (const change of [{ track: null }, { speed: null }, { speed: 0 }, { accuracy: 101 }]) {
    assert.equal(estimateTurnRate({ ...current, ...change }, [origin]), null);
  }
  const missing = { ...origin, timestamp: now - 500, track: null };
  assert.equal(estimateTurnRate(current, [origin, missing]), null, 'do not bridge an interruption in usable tracks');
  assert.equal(estimateTurnRate({ ...current, track: 90.05 }, [
    { ...origin, timestamp: now - 4000 }, origin,
  ]), 0);
});

test('rounded GPS tracks do not lose a steady turn when callbacks arrive between retained samples', () => {
  const history = Array.from({ length: 41 }, (_, index) => readGpsFix(position({
    heading: Math.round(90.495 + index / 10), speed: 60,
  }, now - 4010 + index * 100), null, clock)!);
  const current = readGpsFix(position({ heading: 95, speed: 60 }), null, clock)!;
  const rate = estimateTurnRate(current, history);
  assert.notEqual(rate, null, 'a rounded one-degree step over 10 ms is not a sudden physical turn');
  assert.ok(Math.abs(rate! - 1) < .2);
});

test('a recent continuous turn can recover after an older track discontinuity', () => {
  const history = [180, 90, 91, 92].map((heading, index) =>
    readGpsFix(position({ heading, speed: 60 }, now - 4000 + index * 1000), null, clock)!);
  const current = readGpsFix(position({ heading: 93, speed: 60 }), null, clock)!;
  assert.equal(estimateTurnRate(current, history), 1);
});

for (const hz of [1, 5, 10]) {
  test(`straight-flight heading noise does not become a one-minute turn at ${hz} Hz`, () => {
    const history: GpsFix[] = [];
    for (let sample = 0; sample <= 30 * hz; sample++) {
      const elapsed = sample / hz;
      // Correlated, multi-second noise is more demanding than alternating each fix.
      const heading = (359 + 3 * Math.sin(elapsed * Math.PI / 2) + 360) % 360;
      const fix: GpsFix = { coordinates: [-122, 37], accuracy: 5, track: heading, speed: 60,
        timestamp: now + elapsed * 1000, time: elapsed, estimated: false, altitude: null, altitudeAccuracy: null };
      const rate = estimateTurnRate(fix, history);
      assert.equal(rate ?? 0, 0, `noise at ${elapsed}s must keep the vector straight`);
      history.push(fix);
    }
    // A sustained turn must emerge from the noisy history, and level-out must
    // remove that old turn once a full straight window has replaced it.
    for (let sample = 1; sample <= 12 * hz; sample++) {
      const elapsed = sample / hz;
      const fix = { ...history.at(-1)!, track: (359 + Math.min(elapsed, 6) * 3) % 360,
        timestamp: now + (30 + elapsed) * 1000, time: 30 + elapsed };
      const rate = estimateTurnRate(fix, history);
      if (elapsed >= 4 && elapsed <= 6) assert.ok(rate! > 1.5 && rate! <= 3.5, `turn follows by ${elapsed}s`);
      if (elapsed === 12) assert.equal(rate, 0, 'level-out clears the curved projection');
      history.push(fix);
    }
  });
}

test('turning vectors follow the current tangent, retain one minute of travel and clip at 90 degrees', () => {
  const fix = readGpsFix(position({ heading: 0, speed: 60 }), null, clock)!;
  for (const rate of [-3, -1, 1, 3]) {
    const trace = projectedTrack(fix, rate);
    assert.deepEqual(trace[0], fix.coordinates);
    const seconds = Math.abs(rate) === 3 ? 30 : 60;
    const radius = 60 / (Math.abs(rate) * Math.PI / 180);
    const arc = Math.abs(rate) * seconds * Math.PI / 180;
    const expected = destination(fix.coordinates, rate * seconds / 2, 2 * radius * Math.sin(arc / 2));
    assert.ok(distanceMeters(trace.at(-1)!, expected) < .001);
    const length = trace.slice(1).reduce((sum, point, index) => sum + distanceMeters(trace[index]!, point), 0);
    assert.ok(Math.abs(length - 60 * seconds) < 1, 'travel distance follows the arc, not its chord');
    assert.ok(trace[1]![1] > fix.coordinates[1], 'the line initially follows the current northbound track');
    assert.equal(Math.sign(trace.at(-1)![0] - fix.coordinates[0]), Math.sign(rate));
  }
  for (const rate of [null, 0, NaN, Infinity, 1000]) {
    assert.deepEqual(projectedTrack(fix, rate), projectedTrack(fix));
  }
  for (const [longitude, latitude, heading] of [[179.99, 60, 90], [-179.99, 60, 270], [40, 89.9, 45]] as const) {
    const polar = readGpsFix(position({ longitude, latitude, heading, speed: 100 }), null, clock)!;
    for (const rate of [-1, 1]) {
      const trace = projectedTrack(polar, rate);
      assert.ok(trace.flat().every(Number.isFinite));
      assert.ok(trace.slice(1).every((point, index) => Math.abs(point[0] - trace[index]![0]) < 90));
    }
  }
});

test('shallow turns remain continuous through the former curvature cutoff', () => {
  const history: GpsFix[] = [];
  let previousEnd: [number, number] | undefined;
  for (let second = 0; second < 40; second++) {
    const fix: GpsFix = { coordinates: [-122, 37], accuracy: 5, track: 90 + .51 * second + .15 * Math.sin(second * Math.PI / 3),
      speed: 120 * 1852 / 3600, timestamp: now + second * 1000, time: second, estimated: false, altitude: null, altitudeAccuracy: null };
    const rate = estimateTurnRate(fix, history);
    history.push(fix);
    if (second < 6) continue;
    assert.ok(rate! > 0, 'small noise must not alternate between straight and curved');
    // Hold the tangent fixed to isolate the contribution from curvature.
    const end = projectedTrack({ ...fix, track: 90 }, rate).at(-1)!;
    if (previousEnd) assert.ok(distanceMeters(end, previousEnd) < 100, 'no kilometre-scale endpoint jumps at the threshold');
    previousEnd = end;
  }
});

for (const hz of [1, 5, 10]) {
  test(`display motion damps track noise across north and follows genuine turns at ${hz} Hz`, () => {
    let previous = { fix: null as GpsFix | null, displayTrack: null as number | null, turnRate: null as number | null };
    const history: GpsFix[] = [];
    let lastEnd: [number, number] | undefined;
    for (let i = 0; i <= 50 * hz; i++) {
      const time = i / hz;
      const track = (359 + (time <= 20 ? 3 * Math.sin(time * Math.PI / 2) : Math.min(time - 20, 15) * 3)) % 360;
      const fix: GpsFix = { coordinates: [-122, 37], accuracy: 5, track, speed: 120 * 1852 / 3600,
        timestamp: now + time * 1000, time, estimated: false, altitude: null, altitudeAccuracy: null };
      const raw = structuredClone(fix);
      const motion = smoothMotion(fix, previous, estimateTurnRate(fix, history));
      const geometry = ownshipGeometry({ enabled: true, state: 'tracking', fix, centerRequest: 0, ...motion });
      const vector = geometry.features.find(feature => feature.properties?.kind === 'projection')!.geometry;
      assert.equal(vector.type, 'LineString');
      if (vector.type !== 'LineString') assert.fail();
      const end = vector.coordinates.at(-1)! as [number, number];
      assert.deepEqual(fix, raw, 'display filtering must leave raw observations intact');
      assert.deepEqual(vector.coordinates[0], fix.coordinates);
      assert.equal(geometry.features[0]!.properties?.track, motion.displayTrack, 'aircraft and vector share the displayed direction');
      if (time > 6 && time <= 20) {
        assert.equal(motion.turnRate, 0);
        if (lastEnd) assert.ok(distanceMeters(end, lastEnd) < 120 / hz, 'straight-flight vector no longer swings hundreds of meters');
      }
      if (time === 35) {
        assert.ok(motion.turnRate! > 2.9, 'sustained turns retain their curvature');
        assert.ok(Math.abs(motion.displayTrack! - track) < 6.1, 'direction follows a sustained turn with bounded lag');
      }
      if (time === 50) {
        assert.ok(Math.abs(motion.turnRate!) < .05, 'curvature settles after level-out');
        assert.ok(Math.abs(motion.displayTrack! - track) < .01);
      }
      history.push(fix); previous = { ...motion, fix }; lastEnd = end;
    }
    for (const change of [{ track: null }, { speed: 0, track: null }, { accuracy: 101, track: null },
      { estimated: true }, { timestamp: previous.fix!.timestamp + 3000 }]) {
      const fix = { ...previous.fix!, ...change };
      const motion = smoothMotion(fix, previous, 3);
      assert.equal(motion.turnRate, null, 'invalid or discontinuous motion clears curvature immediately');
      assert.equal(motion.displayTrack, fix.track, 'recovery seeds the current observation, never the old filtered direction');
    }
  });
}

test('ownship stays exactly at the current fix and only the track vector extends into the future', () => {
  const fix = readGpsFix(position({ heading: 90, speed: 60 }), null, clock)!;
  for (const turnRate of [null, -1, 1, 3]) {
    const geometry = ownshipGeometry({ enabled: true, state: 'tracking', fix, centerRequest: 1, turnRate, displayTrack: fix.track });
    const aircraft = geometry.features.find(feature => feature.properties?.kind === 'aircraft')!;
    assert.deepEqual(aircraft.geometry, { type: 'Point', coordinates: [-122, 37] });
    assert.equal(aircraft.properties?.track, 90);
    const vector = geometry.features.find(feature => feature.properties?.kind === 'projection')!.geometry;
    assert.equal(vector.type, 'LineString');
    if (vector.type !== 'LineString') assert.fail('Missing track vector');
    assert.deepEqual(vector.coordinates[0], [-122, 37]);
    assert.ok(distanceMeters(fix.coordinates, vector.coordinates.at(-1)! as [number, number]) > 1000);
    assert.equal(geometry.features.filter(feature => feature.geometry.type === 'Point').length, 1);
  }
});

test('stale fixes lose the aircraft orientation and projection; disabled layers clear all geometry', () => {
  const fix = readGpsFix(position({ speed: 60, heading: 90 }), null, clock)!;
  const snapshot = { enabled: true, state: 'tracking' as const, fix, centerRequest: 1, turnRate: 1, displayTrack: fix.track };
  const live = ownshipGeometry(snapshot);
  assert.deepEqual(live.features.map(feature => feature.properties?.kind), ['aircraft', 'accuracy', 'projection']);
  const stale = ownshipGeometry({ ...snapshot, state: 'stale' });
  assert.deepEqual(stale.features.map(feature => feature.properties?.kind), ['aircraft', 'accuracy']);
  assert.equal(stale.features[0]!.properties?.track, null);
  assert.equal(stale.features[0]!.properties?.live, false);
  assert.deepEqual(ownshipGeometry({ ...snapshot, enabled: false }).features, []);
});

test('impossible reported speeds and position jumps cannot create giant or non-finite projections', () => {
  const overflow = readGpsFix(position({ speed: Number.MAX_VALUE, heading: 90 }), null, clock)!;
  assert.deepEqual(projectedTrack(overflow), []);
  const previous = readGpsFix(position({}, now - 2000), null, clock)!;
  const jump = readGpsFix(position({ longitude: -70, latitude: 20 }), previous, clock)!;
  assert.equal(jump.speed, null);
  assert.equal(jump.track, null);
});
