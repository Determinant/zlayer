import assert from 'node:assert/strict';
import test from 'node:test';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { GeoPointFeature } from '@zlayer/contracts';
import { renderedSnapBounds } from '../src/workspace/map/snap-bounds';
import { routeSnapFeature } from '../src/layers/routes/snapping';

for (const bearing of [0, 45, 90, 135]) test(`snap bounds retain a long label without joining world copies at bearing ${bearing}`, () => {
  const feature: GeoPointFeature = { type: 'Feature', id: 'fix:TAILS',
    geometry: { type: 'Point', coordinates: [-179, 35] }, properties: { ident: 'TAILS' } };
  // Acquire the copy across the dateline. A wide viewport also renders other
  // copies with exactly the same identity and canonical feature coordinates.
  const coordinate: [number, number] = [181, 35];
  const radians = bearing * Math.PI / 180;
  const dx = 4096 * Math.cos(radians), dy = 4096 * Math.sin(radians);
  const copies = [-1, 0, 1].map(copy => ({ x: 3000 + copy * dx, y: 3000 + copy * dy }));
  const map = {
    getCanvas: () => ({ clientWidth: 8000, clientHeight: 8000 }),
    project: ([longitude]: [number, number]) => ({
      x: 3000 + (longitude - coordinate[0]) / 360 * dx,
      y: 3000 + (longitude - coordinate[0]) / 360 * dy,
    }),
    queryRenderedFeatures: ([[left, top], [right, bottom]]: [[number, number], [number, number]]) =>
      copies.some(copy => copy.x - 8 <= right && copy.x + 180 >= left && copy.y - 8 <= bottom && copy.y + 8 >= top)
        ? [feature] : [],
  } as unknown as MapLibreMap;
  const bounds = renderedSnapBounds(map, feature, ['fixes'], coordinate, hit => hit.id === feature.id);
  assert.ok(bounds[0] <= -8 && bounds[0] >= -10);
  assert.ok(bounds[1] <= -8 && bounds[1] >= -10);
  assert.ok(bounds[2] >= 180 && bounds[2] <= 182, 'capture the whole local label');
  assert.ok(bounds[3] >= 8 && bounds[3] <= 10);
  const snap = routeSnapFeature([feature], undefined, () => [100, 0], () => bounds);
  assert.ok(snap);
  assert.equal(routeSnapFeature([], snap, () => [150, 0], () => bounds), snap,
    'a disappearing long label retains the acquired copy');
  assert.equal(routeSnapFeature([], snap, () => [600, 0], () => bounds), undefined,
    'empty space between copies cannot retain the snap');
});
