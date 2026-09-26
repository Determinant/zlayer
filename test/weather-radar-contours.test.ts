import assert from 'node:assert/strict';
import test from 'node:test';
import { contours } from 'd3-contour';
import { compactRadarRing, radarContours } from '../tools/weather-server/radar-contours';
import { simplifyMrms, MRMS_SIMPLIFY_CELLS } from '../tools/weather-server/radar-simplify';

const area = (ring: number[][]) => ring.slice(1).reduce((sum, point, i) =>
  sum + ring[i]![1]! * point[0]! - ring[i]![0]! * point[1]!, 0);
const rings = (polygons: number[][][][]) => polygons.flat().filter(ring => area(ring) !== 0).map(ring => JSON.stringify(ring)).sort();
const polygons = (value: number[][][][]) => value.filter(polygon => area(polygon[0]!) !== 0)
  .map(polygon => rings([polygon])).map(polygon => JSON.stringify(polygon)).sort();

test('indexed radar contours preserve D3 crossings for islands, holes, plateaus and edge echoes', () => {
  let seed = 431;
  for (let sample = 0; sample < 40; sample++) {
    const width = sample % 8 ? 23 : 83, height = sample % 8 ? 17 : 67;
    const choices = sample % 2 ? [0, 5, 10, 15, 40] : [0, 7, 12, 17, 42];
    const values = Float32Array.from({ length: width * height }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return choices[seed % 5]!;
    });
    for (const threshold of [5, 15, 25, 45]) {
      const reference = contours().size([width, height]).contour(values as unknown as number[], threshold);
      assert.deepEqual(rings(radarContours(values, width, height, threshold)), rings(reference.coordinates));
      // At exact threshold plateaus D3's zero-length segment containment can
      // attach holes to distant outlines. Compare ownership off those plateaus.
      if (!choices.includes(threshold)) assert.deepEqual(polygons(radarContours(values, width, height, threshold)), polygons(reference.coordinates));
    }
  }
});

test('zero-length exterior segments cannot claim a distant plateau hole', () => {
  let seed = 431;
  const values = Float32Array.from({ length: 83 * 67 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return [0, 5, 10, 15, 40][seed % 5]!;
  });
  const hole = [[34.5, 19.5], [33.5, 18.5], [34.5, 17.5], [35.5, 18.5], [34.5, 19.5]];
  const parent = radarContours(values, 83, 67, 15).find(polygon => polygon.slice(1).some(ring => JSON.stringify(ring) === JSON.stringify(hole)));
  assert.ok(parent, 'the hole remains attached');
  assert.ok(Math.min(...parent[0]!.map(p => p[0])) < 33.5);
  assert.ok(Math.max(...parent[0]!.map(p => p[0])) > 35.5);
});

test('MRMS simplification bounds edge error and keeps small echoes and nearby threshold geometry', () => {
  type Point = [number, number];
  const outline: Point[] = [[0, 0], [1, -.05], [2, 0], [3, -.03], [4, 0], [4, 3], [0, 3], [0, 0]];
  const tiny: Point[] = [[10, 0], [10.01, 0], [10, .01], [10, 0]];
  const reduced = simplifyMrms([[[outline], [tiny]]])[0]!;
  assert.ok(reduced[0]![0]!.length < outline.length);
  assert.deepEqual(reduced[1]![0], tiny);
  for (const point of outline) {
    const ring = reduced[0]![0]!;
    const distance = Math.min(...ring.slice(1).map((b, i) => {
      const a = ring[i]!, dx = b[0] - a[0], dy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy)));
      return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy);
    }));
    assert.ok(distance <= MRMS_SIMPLIFY_CELLS);
  }
  // A hole and another threshold both live in the narrow strip that an
  // unconstrained simplifier would remove along the bottom edge.
  const hole: Point[] = [[.99, -.04], [1, -.03], [1.01, -.04], [.99, -.04]];
  const guarded = simplifyMrms([[[outline, hole]], [[hole]]]);
  assert.ok(guarded[0]![0]![0]!.some(p => p[0] === 1 && p[1] === -.05));
  assert.deepEqual(guarded[0]![0]![1], hole);
  assert.deepEqual(guarded[1]![0]![0], hole);
});

test('straight contour compaction preserves turns, reversals, closure and small echoes', () => {
  assert.deepEqual(compactRadarRing([[0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [0, 2], [0, 1], [0, 0]]),
    [[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]);
  const small: [number, number][] = [[0, 0], [.01, 0], [0, .01], [0, 0]];
  assert.deepEqual(compactRadarRing(small), small);
  const reversal: [number, number][] = [[0, 0], [2, 0], [1, 0], [1, 1], [0, 0]];
  assert.deepEqual(compactRadarRing(reversal), reversal);
});
