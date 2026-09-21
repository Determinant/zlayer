import assert from 'node:assert/strict';
import test from 'node:test';
import { terrainPointLocation, readTerrainPoint } from '../src/layers/terrain/point-elevation';
import type { TerrainPackage } from '../src/layers/terrain/packages';

test('point sampling uses the finest DEM and handles world copies, tile edges and unsupported coordinates', () => {
  assert.deepEqual(terrainPointLocation([0, 0]), { tile: { z: 13, x: 4096, y: 4096 }, sampleIndex: 0 });
  assert.deepEqual(terrainPointLocation([180, 0]), terrainPointLocation([-180, 0]));
  assert.deepEqual(terrainPointLocation([237.5, 37.25]), terrainPointLocation([-122.5, 37.25]));
  assert.deepEqual(terrainPointLocation([-482.5, 37.25]), terrainPointLocation([-122.5, 37.25]));
  for (const point of [[NaN, 35], [Infinity, 35], [0, NaN], [0, 90], [0, -90]] as [number, number][]) {
    assert.equal(terrainPointLocation(point), undefined);
  }
  for (const latitude of [-85.051129, 85.051129]) {
    const location = terrainPointLocation([0, latitude])!;
    assert.ok(location.tile.y >= 0 && location.tile.y < 8192);
    assert.ok(location.sampleIndex >= 0 && location.sampleIndex < 65536);
  }
});

test('point elevation reads the matching saved package and preserves below-sea-level and missing data', async () => {
  const location = terrainPointLocation([-122.5, 37.25])!;
  const saved: TerrainPackage = { root: 'https://saved.test/terrain', shard: {
    zoom: 13, x: Math.floor(location.tile.x / 64) * 64, y: Math.floor(location.tile.y / 64) * 64,
    sha256: 'a'.repeat(64), file: `${'a'.repeat(64)}.terrain`, byteLength: 100,
  } };
  const newer = { ...saved, root: 'https://browsing.test/terrain' };
  const controller = new AbortController();
  const request = { id: 1, ...location, tileUrl: 'https://fallback.test/{z}/{x}/{y}.png', packages: [saved, newer] };
  const values = new Float32Array(65536).fill(9999);
  const reader = { async read(tile: typeof location.tile, url: string, signal: AbortSignal, sources: unknown, surface?: boolean) {
    assert.deepEqual(tile, location.tile);
    assert.equal(url, request.tileUrl);
    assert.equal(signal, controller.signal);
    assert.deepEqual(sources, [saved]);
    assert.ok(!surface, 'point height retains the same maxima as viewport clearance');
    return values;
  } };
  for (const height of [3210.5, 0, -213.4, NaN]) {
    values[location.sampleIndex] = height;
    assert.equal(await readTerrainPoint(reader, request, controller.signal), Number.isFinite(height) ? Math.fround(height) : null);
  }
  controller.abort();
  await assert.rejects(readTerrainPoint(reader, request, controller.signal), { name: 'AbortError' });
});
