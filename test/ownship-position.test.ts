import assert from 'node:assert/strict';
import test from 'node:test';
import { destination, estimateTurnRate, projectedTrack } from '../src/layers/ownship/position';
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
    for (const elapsed of [0, 100, 300, 800, 1000, 1700, 2400, 3000]) {
      const heading = (360 + rate * (elapsed / 1000 - 1.5)) % 360;
      const fix = readGpsFix(position({ heading, speed: 60 }, now - 3000 + elapsed), null, clock)!;
      const estimate = estimateTurnRate(fix, history);
      if (elapsed < 1000) assert.equal(estimate, null);
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
  assert.equal(estimateTurnRate({ ...current, track: 90.05 }, [origin]), 0);
});

test('rounded GPS tracks do not lose a steady turn when callbacks arrive between retained samples', () => {
  const history = Array.from({ length: 21 }, (_, index) => readGpsFix(position({
    heading: Math.round(90.495 + index / 10), speed: 60,
  }, now - 2010 + index * 100), null, clock)!);
  const current = readGpsFix(position({ heading: 93, speed: 60 }), null, clock)!;
  const rate = estimateTurnRate(current, history);
  assert.notEqual(rate, null, 'a rounded one-degree step over 10 ms is not a sudden physical turn');
  assert.ok(Math.abs(rate! - 1) < .2);
});

test('a recent continuous turn can recover after an older track discontinuity', () => {
  const history = [180, 90, 91].map((heading, index) =>
    readGpsFix(position({ heading, speed: 60 }, now - 3000 + index * 1000), null, clock)!);
  const current = readGpsFix(position({ heading: 92, speed: 60 }), null, clock)!;
  assert.equal(estimateTurnRate(current, history), 1);
});

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

test('ownship stays exactly at the current fix and only the track vector extends into the future', () => {
  const fix = readGpsFix(position({ heading: 90, speed: 60 }), null, clock)!;
  for (const turnRate of [null, -1, 1, 3]) {
    const geometry = ownshipGeometry({ enabled: true, state: 'tracking', fix, centerRequest: 1, turnRate });
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
  const snapshot = { enabled: true, state: 'tracking' as const, fix, centerRequest: 1, turnRate: 1 };
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
