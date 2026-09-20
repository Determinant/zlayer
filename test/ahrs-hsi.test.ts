import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRouteResolver } from '@zlayer/domain';
import { Hsi } from '../src/layers/ahrs/hsi';
import { legGuidance, nearestLeg, type HsiLeg } from '../src/layers/ahrs/navigation';
import { Ahrs } from '../src/layers/ahrs/estimator/ahrs';
import { G } from '../src/layers/ahrs/estimator/math';
import type { AhrsSnapshot } from '../src/layers/ahrs/layer';
import { isMagneticModel } from '../src/layers/ahrs/magnetic-model';

const east: HsiLeg = { key: 'east', from: 'A', to: 'B', start: [0, 0], end: [2, 0] };
const north: HsiLeg = { key: 'north', from: 'B', to: 'C', start: [2, 0], end: [2, 2] };
const near = (actual: number, expected: number, tolerance = .001) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

test('HSI shows route course and distance, with the CDI on the side of the desired path', () => {
  const centered = legGuidance(east, [1, 0])!;
  near(centered.course, 90); near(centered.crossTrackNm, 0);
  near(centered.distanceNm, 60.04046); near(centered.deviation, 0);
  assert.equal(centered.from, false);
  const left = legGuidance(east, [1, .01])!, right = legGuidance(east, [1, -.01])!;
  assert.ok(left.crossTrackNm < 0); assert.ok(left.deviation > 0, 'aircraft left of course: needle right');
  assert.ok(right.crossTrackNm > 0); assert.ok(right.deviation < 0, 'aircraft right of course: needle left');
  near(left.deviation, .6004046 / 2);
  assert.equal(legGuidance(east, [1, -1])!.deviation, -1, 'deviation pegs at full scale');
  assert.equal(legGuidance(east, [3, 0])!.from, true, 'passed waypoint is FROM');
});

test('nearest leg uses distance to the segment and resolves a shared waypoint using track', () => {
  assert.equal(nearestLeg([east, north], [1, .01], 90)!.leg.key, 'east');
  assert.equal(nearestLeg([east, north], [2.01, 1], 0)!.leg.key, 'north');
  assert.equal(nearestLeg([east, north], [2, 0], 0)!.leg.key, 'north');
  assert.equal(nearestLeg([east, north], [2, 0], 90)!.leg.key, 'east');
  const after = { ...east, key: 'after', start: [2, 0] as const, end: [4, 0] as const };
  assert.equal(nearestLeg([east, after], [3, 0], 90)!.leg.key, 'after', 'not an infinitely extended old course');
  assert.equal(nearestLeg([], [0, 0], 0), null);
});

test('great-circle guidance crosses the dateline and updates local course at high latitude', () => {
  const dateline = { ...east, start: [179, 0] as const, end: [-179, 0] as const };
  const crossing = legGuidance(dateline, [180, .01])!;
  near(crossing.course, 90); near(crossing.distanceNm, 60.04346, .002);
  assert.ok(crossing.crossTrackNm < 0);
  const reverse = legGuidance({ ...dateline, start: dateline.end, end: dateline.start }, [180, .01])!;
  near(reverse.course, 270); assert.ok(reverse.crossTrackNm > 0);
  const polar = { ...east, start: [-45, 70] as const, end: [45, 70] as const };
  const startCourse = legGuidance(polar, polar.start)!.course;
  const endCourse = legGuidance(polar, polar.end)!.course;
  assert.ok(startCourse < 50 && endCourse > 130, 'course follows the great circle, not constant departure bearing');
});

test('invalid positions, zero-length legs and antipodal endpoints cannot produce guidance', () => {
  assert.equal(legGuidance({ ...east, end: east.start }, [1, 0]), null);
  assert.equal(legGuidance({ ...east, end: [180, 0] }, [1, 0]), null);
  assert.equal(legGuidance(east, [NaN, 0]), null);
  assert.equal(legGuidance(east, [0, 91]), null);
  assert.equal(legGuidance(east, [0, 90]), null, 'equidistant from every point on the equatorial great circle');
});

function snapshot(): AhrsSnapshot {
  const filter = new Ahrs();
  return { phase: 'ready', attitude: filter.update({ time: 0, gyro: [0, 0, 0], specificForce: [0, 0, -G] }),
    crossed: false, warning: '', message: '', calibrationReason: 'ready', progress: 1, gpsLive: true, gpsUsable: true,
    gpsMessage: '', track: 90, speed: 50, altitude: null, altitudeAccuracy: null, gpsTime: 0, position: [1, 0], trueHeading: false };
}
const route = createRouteResolver([])('000000N0000000E 000000N0020000E');
const render = (state: AhrsSnapshot) => renderToStaticMarkup(createElement(Hsi, { state, route }));

test('HSI prefers GPS track over relative yaw and distinguishes it from aligned true heading', () => {
  const state = snapshot();
  assert.match(render(state), /TRK 090° T/);
  assert.match(render(state), /data-testid="hsi-course"/);
  assert.doesNotMatch(render(state), /data-testid="hsi-heading"/, 'relative yaw is not an absolute heading marker');
  const filter = new Ahrs();
  filter.update({ time: 0, gyro: [0, 0, 0], specificForce: [0, 0, -G] });
  filter.alignHeading(75);
  state.attitude = filter.getState(0); state.trueHeading = true;
  const aligned = render(state);
  assert.match(aligned, /HDG 075° T/);
  assert.match(aligned, /TRK 090° T/, 'heading and ground track remain distinct');
  assert.match(aligned, /rotate\(0\)" data-testid="hsi-heading"/);
  assert.match(aligned, /rotate\(15\)" data-testid="hsi-track"/, 'track diamond shows the drift angle');
  assert.match(aligned, /<title>True heading 075° T<\/title>/);
  state.attitude = { ...state.attitude, headingReference: 'gps-inertial' };
  assert.match(render(state), /HDG 075° T/, 'confident GPS/inertial heading can drive the compass too');
  state.attitude = { ...state.attitude, headingStatus: 'recovering' };
  assert.match(render(state), /TRK 090° T/, 'previous heading source does not imply a valid current heading');
  assert.match(render(state), /data-testid="hsi-course"/, 'GPS route guidance survives heading recovery');
  assert.doesNotMatch(render(state), /data-testid="hsi-heading"/);
  state.attitude = { ...state.attitude, headingStatus: 'tracking' };
  state.attitude = { ...state.attitude, attitudeStd: [3, 3, 25] };
  assert.doesNotMatch(render(state), /data-testid="hsi-heading"/, 'uncertain heading falls back to ground track');
  state.attitude = { ...state.attitude, status: 'interrupted' };
  assert.match(render(state), /TRK 090° T/, 'GPS guidance can continue after losing AHRS heading');
  assert.doesNotMatch(render(state), /data-testid="hsi-heading"/, 'an interrupted heading cannot leave a valid-looking marker');
});

test('without GPS the calibrated HSI follows relative yaw under its cross, including high uncertainty', () => {
  const state = snapshot();
  state.gpsLive = false; state.gpsUsable = false; state.position = null; state.track = null;
  for (const status of ['coasting', 'degraded'] as const) {
    state.attitude = { ...state.attitude!, yaw: 42, status };
    const output = render(state);
    assert.match(output, /IMU · REL/);
    assert.match(output, /REL 042°/);
    assert.match(output, /rotate\(-42\)" data-testid="hsi-compass"/);
    assert.match(output, /data-testid="hsi-relative-heading"/);
    assert.match(output, /No GPS\. Relative direction 042°\. Heading unverified/);
    assert.match(output, /data-testid="hsi-invalid"/);
    assert.doesNotMatch(output, /data-testid="hsi-(?:heading|track|course|deviation)"/);
    assert.doesNotMatch(output, />[NESW]<\/text>|HDG 042°|MAG|TRUE/, 'relative yaw never impersonates north');
    state.attitude = { ...state.attitude, yaw: 65 };
    assert.match(render(state), /rotate\(-65\)" data-testid="hsi-compass"/);
  }
  state.gpsLive = true; state.gpsUsable = true; state.position = [1, 0]; state.track = 90;
  assert.match(render(state), /TRK 090° T/);
  assert.match(render(state), /data-testid="hsi-course"/);
  assert.doesNotMatch(render(state), /IMU · REL|data-testid="hsi-invalid"/);
});

test('position-only HSI stays relative without inventing a geographic heading', () => {
  const state = snapshot();
  state.track = null; state.speed = 0; state.gpsUsable = false;
  state.attitude = { ...state.attitude!, yaw: 42 };
  const output = render(state);
  assert.match(output, /REL 042°/);
  assert.match(output, /Relative direction 042°\. Heading unverified/);
  assert.match(output, /rotate\(-42\)" data-testid="hsi-compass"/);
  assert.match(output, /data-testid="hsi-relative-heading"/);
  assert.match(output, /data-testid="hsi-invalid"/);
  assert.doesNotMatch(output, /N UP|No GPS|data-testid="hsi-(?:heading|track|course|deviation)"/);
});

test('invalid low-speed GPS track keeps relative yaw without corrupting the compass', () => {
  const state = snapshot();
  state.gpsUsable = false; state.speed = 5;
  for (const track of [null, NaN, Infinity]) {
    state.track = track;
    const output = render(state);
    assert.match(output, /REL 000°/);
    assert.match(output, /Low Speed/);
    assert.match(output, /data-testid="hsi-relative-heading"/);
    assert.match(output, /data-testid="hsi-invalid"/);
    assert.doesNotMatch(output, /NaN|Infinity|data-testid="hsi-(?:heading|track|course|deviation)"/);
  }
});

test('aligned heading remains visible without GPS, and stopped motion removes the inertial reference', () => {
  const state = snapshot();
  state.gpsLive = false; state.gpsUsable = false; state.position = null; state.track = null;
  state.attitude = { ...state.attitude!, yaw: 75, headingStatus: 'tracking', attitudeStd: [3, 3, 5] };
  assert.match(render(state), /IMU · TRUE/);
  assert.match(render(state), /HDG 075° T/);
  assert.match(render(state), /data-testid="hsi-heading"/);
  assert.match(render(state), /data-testid="hsi-invalid"/);
  for (const status of ['stale', 'interrupted', 'waiting'] as const) {
    state.attitude = { ...state.attitude, status };
    assert.doesNotMatch(render(state), /data-testid="hsi-(?:relative-heading|heading)"|HDG 075°|REL /);
  }
  state.attitude = { ...state.attitude, status: 'coasting' };
  for (const phase of ['idle', 'calibrating', 'error'] as const) {
    state.phase = phase;
    assert.doesNotMatch(render(state), /data-testid="hsi-(?:relative-heading|heading)"|HDG 075°|REL /);
  }
});

test('GPS failure suppresses stale guidance; missing track stays relative and no route shows an empty state', () => {
  const state = snapshot();
  state.gpsLive = false; state.gpsUsable = false;
  assert.match(render(state), /No GPS/);
  assert.doesNotMatch(render(state), /data-testid="hsi-course"/);
  assert.match(render(state), /data-testid="hsi-invalid"/);
  state.gpsLive = true; state.gpsUsable = true; state.track = null;
  assert.match(render(state), /REL 000°/);
  assert.doesNotMatch(render(state), /data-testid="hsi-course"/);
  state.track = 90;
  assert.match(renderToStaticMarkup(createElement(Hsi, { state })), /Add a route/);
  state.position = null;
  assert.match(render(state), /No GPS/);
});

test('low speed retains heading-referenced course and CDI, including at rest', () => {
  const state = snapshot(), filter = new Ahrs();
  filter.update({ time: 0, gyro: [0, 0, 0], specificForce: [0, 0, -G] });
  filter.alignHeading(75);
  state.attitude = filter.getState(0); state.trueHeading = true;
  state.gpsUsable = false;
  for (const speed of [0, .5, 5, 9.99]) {
    state.speed = speed;
    const output = render(state);
    assert.match(output, /data-testid="hsi-caution">Low Speed/);
    assert.doesNotMatch(output, /No GPS|data-testid="hsi-invalid"/);
    assert.match(output, /HDG 075° T/);
    assert.match(output, /rotate\(15\)" data-testid="hsi-course"/);
    assert.match(output, /data-testid="hsi-deviation"/);
    assert.match(output, /60\.0 nautical miles to waypoint/);
  }
});

test('usable low-speed ground track still orients the route without an aligned heading', () => {
  const state = snapshot();
  state.gpsUsable = false; state.speed = 5;
  const output = render(state);
  assert.match(output, /TRK 090° T/);
  assert.match(output, /rotate\(0\)" data-testid="hsi-course"/);
  assert.match(output, /data-testid="hsi-caution">Low Speed/);
  assert.doesNotMatch(output, /data-testid="hsi-(?:heading|relative-heading|invalid)"/);
});

const model: unknown = JSON.parse(readFileSync(new URL('./fixtures/magnetic-model.json', import.meta.url), 'utf8'));
assert.ok(isMagneticModel(model));

test('stationary HSI stays relative even when magnetic variation and a GPS track are available', t => {
  t.mock.method(Date, 'now', () => Date.UTC(2026, 8, 18));
  const state = snapshot();
  state.gpsUsable = false; state.speed = 0; state.track = 90;
  state.position = [-122, 37.02]; state.altitude = 3048;
  state.attitude = { ...state.attitude!, yaw: 42 };
  const californiaRoute = createRouteResolver([])('370000N1230000W 370000N1210000W');
  const output = renderToStaticMarkup(createElement(Hsi, { state, route: californiaRoute, magneticModel: model }));
  assert.match(output, /IMU · REL/);
  assert.match(output, /REL 042°/);
  assert.match(output, /rotate\(-42\)" data-testid="hsi-compass"/);
  assert.match(output, /data-testid="hsi-relative-heading"/);
  assert.doesNotMatch(output, /N UP|MAG|TRUE|>[NESW]<|data-testid="hsi-(?:heading|track|course|deviation)"/);
});

test('magnetic rose, heading, track and course share one correction while CDI geometry stays true', t => {
  t.mock.method(Date, 'now', () => Date.UTC(2026, 8, 18));
  const state = snapshot(), filter = new Ahrs();
  filter.update({ time: 0, gyro: [0, 0, 0], specificForce: [0, 0, -G] });
  filter.alignHeading(75);
  state.attitude = filter.getState(0); state.trueHeading = true;
  const californiaRoute = createRouteResolver([])('370000N1230000W 370000N1210000W');
  state.position = [-122, 37.02]; state.altitude = 3048;
  const trueDisplay = renderToStaticMarkup(createElement(Hsi, { state, route: californiaRoute }));
  const magDisplay = renderToStaticMarkup(createElement(Hsi, { state, route: californiaRoute, magneticModel: model }));
  assert.match(magDisplay, /IMU · MAG/);
  assert.match(magDisplay, /HDG 062° M/); assert.match(magDisplay, /TRK 077° M/);
  assert.match(magDisplay, /Course 077° magnetic/);
  assert.match(magDisplay, /TRUE HDG 075° T/);
  assert.match(magDisplay, /<title>True heading 075° T<\/title>/);
  assert.doesNotMatch(magDisplay, /hsi-true-north|N′/);
  assert.match(magDisplay, /VAR 12\.6° E/);
  for (const id of ['hsi-course', 'hsi-deviation', 'hsi-track', 'hsi-heading']) {
    const transform = new RegExp(`transform="([^"]+)"\\s+data-testid="${id}"`);
    assert.ok(transform.test(magDisplay), id);
    assert.equal(magDisplay.match(transform)![1], trueDisplay.match(transform)![1], id);
  }
  assert.notEqual(magDisplay.match(/rotate\(([^)]+)\)" data-testid="hsi-compass"/)![1],
    trueDisplay.match(/rotate\(([^)]+)\)" data-testid="hsi-compass"/)![1]);
  // Relative attitude must still produce track, never an invented magnetic heading.
  state.attitude = { ...state.attitude, headingReference: 'relative', headingStatus: 'acquiring' };
  const trackOnly = renderToStaticMarkup(createElement(Hsi, { state, route: californiaRoute, magneticModel: model }));
  assert.match(trackOnly, /TRK 077° M/); assert.doesNotMatch(trackOnly, /data-testid="hsi-heading"/);
});

test('expired models and weak polar fields explicitly fall back to TRUE; GPS loss still removes CDI', t => {
  let now = Date.UTC(2030, 0, 1);
  t.mock.method(Date, 'now', () => now);
  const state = snapshot();
  const output = () => renderToStaticMarkup(createElement(Hsi, { state, route, magneticModel: model }));
  assert.match(output(), /Magnetic model expired · using TRUE/);
  assert.match(output(), /TRK 090° T/); assert.doesNotMatch(output(), /GPS · MAG/);
  now = Date.UTC(2026, 8, 18);
  for (const position of [[140, 86], [0, 85]] as const) {
    state.position = position;
    assert.match(output(), /Magnetic reference weak · using TRUE/);
    assert.doesNotMatch(output(), /GPS · MAG/);
  }
  state.position = [-122, 37]; state.gpsLive = false; state.gpsUsable = false;
  assert.match(output(), /No GPS/); assert.doesNotMatch(output(), /data-testid="hsi-course"/);
});
