import assert from 'node:assert/strict';
import test from 'node:test';
import type { Bounds } from '@zlayer/contracts';
import { obstructionBoundsContain, obstructionCountInView, paddedObstructionBounds } from '../src/layers/obstructions/coverage';
import { ObstructionIndex } from '../src/layers/obstructions/data';
import { project, type Segment } from '../src/layers/terrain/geometry';

test('obstruction margins follow Mercator map space and stop at one world and the poles', () => {
  const bounds: Bounds = [-10, 60, 10, 70], padded = paddedObstructionBounds(bounds, 0.5);
  assert.equal(padded[0], -20); assert.equal(padded[2], 20);
  const height = project([0, bounds[1]])[1] - project([0, bounds[3]])[1];
  const expanded = project([0, padded[1]])[1] - project([0, padded[3]])[1];
  assert.ok(Math.abs(expanded - height * 2) < 1e-12);
  assert.ok(obstructionBoundsContain(padded, bounds));
  const world = paddedObstructionBounds([-300, -85, 300, 85], 0.5);
  assert.equal(world[2] - world[0], 360);
  assert.ok(world[1] >= -85.051129 && world[3] <= 85.051129);
  assert.ok(obstructionBoundsContain(world, paddedObstructionBounds([-900, -85, 900, 85], 0.25)));
});

test('obstruction coverage handles datelines, world copies, inclusive edges and real gaps', () => {
  const outer = paddedObstructionBounds([170, -10, -170, 10], 0.5);
  assert.equal(outer[0], 160); assert.equal(outer[2], 200);
  for (const inner of [[175, -5, -175, 5], [-185, -5, -175, 5], [535, -5, 545, 5], [160, -10, 200, 10]]) {
    assert.ok(obstructionBoundsContain(outer, inner as Bounds));
  }
  assert.equal(obstructionBoundsContain(outer, [155, -5, 175, 5]), false);
  assert.equal(obstructionBoundsContain(outer, [175, -30, 185, 5]), false);
  assert.equal(obstructionBoundsContain(outer, [-170, -5, 170, 5]), false);
});

test('buffered queries preserve every in-view feature, corridor fade and height tier', () => {
  const coordinates = [[-1.5, 0], [-1, 0], [0, 0], [1, 0], [1.5, 0], [179.8, 0], [-179.8, 0], [0, 75], [10, 75]];
  const heights = [499, 500, 999, 1000, 1500, 2000];
  const index = new ObstructionIndex(coordinates.length * heights.length);
  let id = 0;
  for (const [lon, lat] of coordinates) for (const height of heights) index.add({ type: 'Feature', id: `06-${String(++id).padStart(6, '0')}`,
    geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { heightAglFt: height, elevationMslFt: height + 50,
      quantity: 1, lightingCode: 'N', structureType: 'TOWER', verified: true } });
  index.finish();
  const routes: Segment[][] = [[], [[project([-2, 0]), project([2, 0])]], [[project([179, 0]), project([181, 0])]]];
  const views: Bounds[] = [[-1, -1, 1, 1], [179, -1, -179, 1], [-181, -1, -179, 1], [539, -1, 541, 1],
    [-5, 74, 5, 76], [-200, -80, 200, 80]];
  for (const bounds of views) for (const segments of routes) for (const zoom of [3, 6.99, 7, 7.99, 8, 9, 10, 13]) {
    const expected = index.query(bounds, segments, zoom);
    const buffered = index.query(paddedObstructionBounds(bounds, 0.5), segments, zoom);
    const visible = buffered.features.filter(point => {
      const [lon, lat] = point.geometry.coordinates as [number, number];
      return obstructionBoundsContain(bounds, [lon, lat, lon, lat]);
    });
    const sorted = (features: typeof visible) => [...features].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    assert.deepEqual(sorted(visible), sorted(expected.features), `${bounds} at zoom ${zoom}`);
    assert.equal(obstructionCountInView(buffered, bounds, zoom), expected.features.length);
  }
  const close = index.query([-1, -1, 1, 1], [], 10);
  assert.equal(obstructionCountInView(close, [-1, -1, 1, 1], 7), index.query([-1, -1, 1, 1], [], 7).features.length,
    'counts obey current zoom even before the source replacement finishes');
});
