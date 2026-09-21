import assert from 'node:assert/strict';
import test from 'node:test';
import { terrainCorridor } from '../src/layers/terrain/corridor';
import { corridorDistance, project, type Point, type Segment } from '../src/layers/terrain/geometry';

const segment = (a: Point, b: Point): Segment => [project(a), project(b)];
const paths = (segments: Segment[]) => terrainCorridor(segments).features.flatMap(feature => feature.geometry.coordinates);

function assertBoundary(segments: Segment[], wrapped = false) {
  const nearby = wrapped ? [-1, 0, 1].flatMap(shift => segments.map(([a, b]): Segment =>
    [[a[0] + shift, a[1]], [b[0] + shift, b[1]]])) : segments;
  const lines = paths(segments);
  assert.ok(lines.length > 0);
  for (const line of lines) for (let i = 1; i < line.length; i++) {
    const a = project(line[i - 1] as Point), b = project(line[i] as Point);
    // Check between vertices too: caps and latitude-varying sides must stay at
    // the 4 NM core, including where the polygon union introduces intersections.
    for (const t of [0, 0.5, 1]) {
      const distance = corridorDistance([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], nearby);
      assert.ok(Math.abs(distance - 4) < 0.003, `boundary is ${distance} NM from the route`);
    }
  }
  return lines;
}

test('the corridor boundary stays 4 NM from horizontal, diagonal and long north/south legs at different latitudes', () => {
  for (const latitude of [0, 37, 65, 80]) {
    for (const end of [[-120, latitude], [-120, latitude + 1], [-122, latitude - 15]] as Point[]) {
      const lines = assertBoundary([segment([-122, latitude], end)]);
      assert.equal(lines.length, 1);
      assert.deepEqual(lines[0]![0], lines[0]!.at(-1), 'rounded end caps close the outline');
    }
  }
});

test('turns, crossings and repeated legs show only the perimeter of the combined core', () => {
  const legs = [segment([-122.4, 37.5], [-122.1, 37.5]), segment([-122.1, 37.5], [-121.85, 37.2]),
    segment([-122.3, 37.3], [-121.95, 37.65])];
  assert.equal(assertBoundary(legs).length, 1);
  assert.deepEqual(paths([...legs, legs[0]!, [legs[0]![1], legs[0]![0]]]), paths(legs));
});

test('route gaps stay separate and no legs produce no boundary', () => {
  assert.deepEqual(terrainCorridor([]).features, []);
  assert.equal(assertBoundary([segment([-122, 37], [-121, 37]), segment([-119, 37], [-118, 37])]).length, 2);
  assertBoundary([segment([-122, 37], [-122, 37])]);
});

test('antimeridian crossings join both world copies without a false boundary along the seam', () => {
  const legs = [segment([179.7, 60], [180.1, 60]), segment([-179.9, 60], [-179.6, 60.2])];
  const lines = assertBoundary(legs, true);
  assert.ok(lines.some(line => line.some(([longitude]) => longitude! === 180)));
  assert.ok(lines.some(line => line.some(([longitude]) => longitude! === -180)));
  for (const line of lines) for (let i = 1; i < line.length; i++) {
    assert.ok(Math.abs(line[i]![0]! - line[i - 1]![0]!) < 1, 'no long line across the world');
    assert.ok(Math.abs(line[i]![0]!) !== 180 || line[i]![0] !== line[i - 1]![0], 'no seam-closing line');
  }
});
