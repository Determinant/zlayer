import assert from 'node:assert/strict';
import test from 'node:test';
import { bearing, destination } from '../src/approach-geometry.js';
import { difference, joinCourse, rangeIntersection, rayIntersection, selfCrosses, turnToFix, turnToHeading } from '../src/approach-path-geometry.js';
import { distanceNm } from '../src/route.js';
import type { ApproachCoordinate as Coordinate } from '@zlayer/contracts';

test('a permitted return crossing exempts only its exact segment pair', () => {
  const path: Coordinate[] = [[0, 0], [2, 2], [2, 0], [0, 2]];
  assert.equal(selfCrosses(path), true);
  assert.equal(selfCrosses(path, [0, 2]), false);
  assert.equal(selfCrosses(path, [1, 2]), true);
  assert.equal(selfCrosses([...path, [3, 1]], [0, 2]), true, 'a second crossing still requires review');
  assert.equal(selfCrosses(path.map(([x, y]) => [((x + 179 + 180) % 360) - 180, y]), [0, 2]), false);
});

test('station-range intersection chooses the first forward solution, including across the date line', () => {
  for (const center of [[0, 0], [179.99, 45], [-120, -38]] as Coordinate[]) {
    const from = destination(center, 270, 5), heading = bearing(from, center);
    const end = rangeIntersection(from, heading, center, 2)!;
    assert.ok(Math.abs(distanceNm(center, end) - 2) < .00001);
    assert.ok(Math.abs(distanceNm(from, end) - 3) < .00001);
    assert.equal(rangeIntersection(from, heading + 180, center, 2), undefined);
    assert.equal(rangeIntersection(from, heading + 90, center, 2), undefined);
  }
});

test('referenced radials must intersect both forward rays locally', () => {
  const from: Coordinate = [179.95, 0], station: Coordinate = [-179.95, -.1];
  const p = rayIntersection(from, 90, station, 0)!;
  assert.ok(distanceNm(from, p) < 10);
  assert.ok(Math.abs(difference(bearing(station, p), 0)) < .001);
  assert.equal(rayIntersection(from, 270, station, 0), undefined);
  assert.equal(rayIntersection(from, 90, station, 180), undefined);
});

test('bounded turn primitives honor turn side, tangent departure, and CF arrival course', () => {
  const start: Coordinate = [-122, 38], end = destination(start, 45, 8);
  for (const turn of ['L', 'R'] as const) {
    const side = turn === 'R' ? 1 : -1;
    const heading = turnToHeading(start, 0, 90, turn);
    const direct = turnToFix(start, 0, end, turn)!;
    const join = joinCourse(start, 0, end, 45, turn)!;
    for (const path of [heading, direct, join]) {
      assert.deepEqual(path[0], start);
      assert.ok(difference(bearing(path[0]!, path[1]!), 0) * side > 0, turn);
      assert.ok(Math.abs(difference(bearing(path[0]!, path[1]!), 0)) < 3);
      assert.ok(path.every(c => c.every(Number.isFinite) && distanceNm(start, c) < 15));
    }
    assert.deepEqual(direct.at(-1), end);
    assert.deepEqual(join.at(-1), end);
    assert.ok(Math.abs(difference(bearing(join.at(-1)!, join.at(-2)!) + 180, 45)) < .001);
    assert.equal(selfCrosses(join), false);
  }
});
