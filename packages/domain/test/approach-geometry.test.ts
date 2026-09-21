import assert from 'node:assert/strict';
import test from 'node:test';
import { bearing, holdingEntry, missedClimb } from '../src/approach-geometry.js';
import { distanceNm } from '../src/route.js';
import type { ApproachCoordinate, ApproachLeg, ApproachRoute } from '@zlayer/contracts';

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

test('a bounded missed intercept retains the climb, intercept heading, turn direction and inbound course', () => {
  const procedure: ApproachRoute = { id: 'KNUQ:I32R', airport: 'KNUQ', ident: 'I32R', magneticVariation: 16, transitions: [], final: [] };
  const from: ApproachCoordinate = [-122.04284722222222, 37.40603888888889];
  const climb: ApproachLeg = { path: 'CA', magneticCourse: 321.7 };
  const intercept: ApproachLeg = { path: 'VI', magneticCourse: 310 };
  const next: ApproachLeg = { path: 'CF', magneticCourse: 319, fix: { ident: 'OAK', coordinate: [-122.22359166666666, 37.725925000000004] } };
  const coordinates = missedClimb(from, climb, next, procedure, intercept)!;
  assert.ok(Math.abs(bearing(coordinates[0]!, coordinates[1]!) - 337.7) < .01);
  assert.ok(coordinates.some((p, i) => i > 0 && distanceNm(coordinates[i - 1]!, p) > 1 &&
    Math.abs(bearing(coordinates[i - 1]!, p) - 326) < .01), 'retain the 310 magnetic intercept heading');
  assert.ok(Math.abs(bearing(coordinates.at(-1)!, coordinates.at(-2)!) - 155) < .01, 'finish along the known inbound course');
  assert.deepEqual(coordinates[0], from);
  assert.deepEqual(coordinates.at(-1), next.fix!.coordinate);
  for (const turn of ['L', 'R'] as const) {
    const path = missedClimb([0, 0], { path: 'CA', trueCourse: 0 },
      { path: 'CF', trueCourse: 45, fix: { ident: 'END', coordinate: [.2, .2] }, turn: turn === 'L' ? 'R' : 'L' },
      procedure, { path: 'VI', trueCourse: 90, turn })!;
    assert.equal(path.some(p => p[0] < -.001), turn === 'L', 'the intercept leg owns the initial turn direction');
  }
});
