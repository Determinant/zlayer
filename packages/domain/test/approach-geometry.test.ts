import assert from 'node:assert/strict';
import test from 'node:test';
import { bearing, courseIntercept, holdingEntry } from '../src/approach-geometry.js';
import { distanceNm } from '../src/route.js';
import type { ApproachCoordinate, ApproachLeg, ApproachRoute } from '@zlayer/contracts';

test('Napa intercept preserves both published courses with magnetic or true coding', () => {
  const procedure: ApproachRoute = { id: 'KAPC:I01LZ', airport: 'KAPC', ident: 'I01LZ', magneticVariation: 15, transitions: [], final: [] };
  const from: ApproachCoordinate = [-122.38366666666667, 37.94068333333333];
  const next: ApproachLeg = { path: 'CF', magneticCourse: 5.7, fix: { ident: 'FESAV', coordinate: [-122.37087777777776, 38.029125] } };
  const coordinates = courseIntercept(from, { path: 'VI', magneticCourse: 320.7 }, next, procedure)!;
  assert.ok(Math.abs(bearing(coordinates[0]!, coordinates[1]!) - 335.7) < .001);
  assert.ok(Math.abs(bearing(coordinates.at(-1)!, coordinates.at(-2)!) - 200.7) < .001);
  delete next.magneticCourse; next.trueCourse = 20.7;
  const truth = courseIntercept(from, { path: 'CI', trueCourse: 335.7 }, next, procedure)!;
  truth.forEach((p, i) => assert.ok(distanceNm(p, coordinates[i]!) < 1e-8));
});

test('bounded intercepts stay local across the date line and reject backwards or parallel courses', () => {
  const procedure: ApproachRoute = { id: 'TEST:R01', airport: 'TEST', ident: 'R01', transitions: [], final: [] };
  const from: ApproachCoordinate = [179.95, 0];
  const next: ApproachLeg = { path: 'CF', trueCourse: 0, fix: { ident: 'END', coordinate: [-179.9, .1] } };
  const coordinates = courseIntercept(from, { path: 'CI', trueCourse: 90 }, next, procedure)!;
  assert.deepEqual(coordinates[0], from);
  assert.deepEqual(coordinates.at(-1), next.fix!.coordinate);
  assert.ok(Math.abs(bearing(coordinates[0]!, coordinates[1]!) - 90) < .001);
  assert.ok(Math.abs(bearing(coordinates.at(-1)!, coordinates.at(-2)!) - 180) < .001);
  assert.ok(coordinates.every((p, i) => p.every(Number.isFinite) && (!i || distanceNm(coordinates[i - 1]!, p) < 10)));
  for (const heading of [0, 270]) assert.equal(courseIntercept(from, { path: 'VI', trueCourse: heading }, next, procedure), undefined);
  assert.equal(courseIntercept(from, { path: 'VI', trueCourse: 90 }, { ...next, turn: 'R' }, procedure), undefined,
    'do not replace a coded long turn with a short left turn');
});

test('FAA holding sectors rotate with inbound course and mirror for left turns', () => {
  const cases = [[0, 'Direct'], [90, 'Direct'], [120, 'Teardrop'], [170, 'Teardrop'],
    [190, 'Parallel'], [260, 'Parallel'], [300, 'Direct'], [350, 'Direct']] as const;
  for (const inbound of [0, 37, 95, 315, 359]) for (const turn of ['L', 'R'] as const) {
    for (const [offset, entry] of cases) {
      const arrival = (inbound + (turn === 'R' ? offset : -offset) + 360) % 360;
      assert.equal(holdingEntry(inbound, arrival, turn), entry, `${turn}, inbound ${inbound}, arrival ${arrival}`);
    }
  }
  assert.equal(holdingEntry(0, 289.9, 'R'), 'Parallel');
  assert.equal(holdingEntry(0, 290.1, 'R'), 'Direct');
  assert.equal(holdingEntry(0, 109.9, 'R'), 'Direct');
  assert.equal(holdingEntry(0, 110.1, 'R'), 'Teardrop');
  assert.equal(holdingEntry(0, 179.9, 'R'), 'Teardrop');
  assert.equal(holdingEntry(0, 180.1, 'R'), 'Parallel');
});
