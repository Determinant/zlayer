import assert from 'node:assert/strict';
import test from 'node:test';
import clipping, { type MultiPolygon, type Polygon } from 'polygon-clipping';
import { project, nmPerWorldUnit, type Point } from '../src/core/geo/route-corridor';
import { containsPoint, coveredRouteNm, prepareLandingMask } from '../src/layers/glide/landing-geometry';
import type { GlideAreas } from '../src/layers/glide/types';
const ring = (w: number, e: number) => [[w, -1], [e, -1], [e, 1], [w, 1], [w, -1]];
test('route length uses polygon intersections, excludes holes, and avoids double counting overlaps', () => {
  const coverage: GlideAreas = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {},
    geometry: { type: 'MultiPolygon', coordinates: [[ring(-1, 1), ring(-.2, .2)], [ring(.5, 1)]] } }] };
  const polygon = coverage.features[0]!.geometry.coordinates[0]!.map(r => r.map(p => project(p as Point)));
  assert.equal(containsPoint(project([0, 0]), polygon), false);
  assert.equal(containsPoint(project([.5, 0]), polygon), true);
  const nmPerDegree = nmPerWorldUnit(.5) / 360;
  assert.ok(Math.abs(coveredRouteNm([[project([-2, 0]), project([2, 0])]], coverage) - 1.6 * nmPerDegree) < 1e-6);
  assert.equal(coveredRouteNm([[project([2, 0]), project([3, 0])]], coverage), 0);
  assert.ok(Math.abs(coveredRouteNm([[project([358, 0]), project([362, 0])]], coverage) - 1.6 * nmPerDegree) < 1e-6);
});

test('prepared candidate clipping matches exact intersections for concave ranges, holes and boundary contacts', () => {
  const rectangle = (w: number, s: number, e: number, n: number): Point[] => [[w, s], [e, s], [e, n], [w, n], [w, s]];
  const mask: MultiPolygon = [
    [[[0, 0], [8, 0], [8, 8], [5, 8], [5, 3], [3, 3], [3, 8], [0, 8], [0, 0]], rectangle(.5, .5, 2, 2)],
    [rectangle(10, 0, 12, 8)],
  ];
  const prepared = prepareLandingMask(mask), before = structuredClone(mask);
  const candidates: Polygon[] = [
    [rectangle(0, 0, 3, 3)], // Includes an entire mask hole.
    [rectangle(.75, .75, 1.75, 1.75)], // Entirely within that hole.
    [rectangle(3.5, 4, 4.5, 5)], // Within the concave cutout.
    [rectangle(-1, -1, 13, 9), rectangle(9, -1, 13, 9)],
    [rectangle(1, 2, 2, 3)], // Touches the hole boundary.
    [[[1, 1], [11, 1], [11, 7], [1, 1]]],
  ];
  for (let y = -1; y <= 8; y++) for (let x = -1; x <= 12; x++) candidates.push([rectangle(x, y, x + .75, y + .75)]);
  for (const candidate of candidates) {
    const original = structuredClone(candidate), expected = clipping.intersection(candidate, mask), actual = prepared.clip(candidate);
    assert.deepEqual(clipping.xor(actual, expected), [], 'no added or lost ground');
    assert.equal(actual.length > 0, expected.length > 0, 'selection matches exact intersection');
    assert.deepEqual(candidate, original);
  }
  assert.deepEqual(mask, before);
  assert.deepEqual(prepareLandingMask([]).clip(candidates[0]!), []);
});
