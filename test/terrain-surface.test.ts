import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { terrainSpacing, terrainShardKey } from '@zlayer/contracts';
import { project, unproject, type Tile } from '../src/layers/terrain/geometry';
import type { TerrainPackage } from '../src/layers/terrain/packages';

const loader = registerHooks({ resolve(specifier, context, next) {
  if (specifier === './packages' && context.parentURL?.endsWith('/terrain/geographic.ts')) return {
    shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(
      'export const readPackagedElevation = (...args) => globalThis.readSurfaceGrid(...args);'),
  };
  return next(specifier, context);
} });
const { geographicTiles, geographicSamples, readGeographicElevation } = await import('../src/layers/terrain/geographic');
loader.deregister();
const tile: Tile = { z: 13, x: 1372, y: 3163 };
const step = terrainSpacing(11);
const slope = (lon: number, lat: number) => 5000 + (lon + 119.7) * 15000 + (lat - 37.9) * 20000;

function fixture(t: test.TestContext, missing = false) {
  const calls: boolean[] = [];
  const origin = Object.getOwnPropertyDescriptor(globalThis, 'readSurfaceGrid');
  const samples = geographicSamples(tile, 11);
  const hole = [Math.floor(samples.columnCenters[128]!), Math.floor(samples.rowCenters[128]!)];
  Object.defineProperty(globalThis, 'readSurfaceGrid', { configurable: true,
    value: async (grid: Tile, _source: unknown, signal: AbortSignal, version: number, surface: boolean) => {
      signal.throwIfAborted(); assert.equal(version, 2); calls.push(surface);
      return Float32Array.from({ length: 256 * 256 }, (_, i) => {
        const x = grid.x * 256 + i % 256, y = grid.y * 256 + Math.floor(i / 256);
        if (missing && x === hole[0] && y === hole[1]) return NaN;
        return surface ? slope(-180 + (x + 0.5) * step, 90 - (y + 0.5) * step) : 12000;
      });
    } });
  t.after(() => { if (origin) Object.defineProperty(globalThis, 'readSurfaceGrid', origin); else Reflect.deleteProperty(globalThis, 'readSurfaceGrid'); });
  const sources = new Map<string, TerrainPackage>();
  for (const dem of [tile, { ...tile, x: tile.x + 1 }, { ...tile, y: tile.y + 1 }])
    for (const grid of geographicTiles(dem, 11, true)) {
      const key = terrainShardKey(grid.z, grid.x, grid.y);
      sources.set(key, { root: `https://surface.test/${encodeURIComponent(t.name)}`, grid: 'EPSG:4326', maxZoom: 11,
        shard: { zoom: 11, x: Math.floor(grid.x / 64) * 64, y: Math.floor(grid.y / 64) * 64,
          file: `${'a'.repeat(64)}.terrain`, sha256: 'a'.repeat(64), byteLength: 100 } });
    }
  return { calls, read: (dem = tile, surface = true) => readGeographicElevation(dem, [...sources.values()], new AbortController().signal, undefined, surface) };
}

test('geographic interpolation reproduces an actual slope across Mercator and geographic tile seams', async t => {
  const { read } = fixture(t);
  for (const dem of [tile, { ...tile, x: tile.x + 1 }, { ...tile, y: tile.y + 1 }]) {
    const values = await read(dem);
    for (const y of [0, 1, 70, 128, 254, 255]) for (const x of [0, 1, 70, 128, 254, 255]) {
      const [lon, lat] = unproject([(dem.x + (x + 0.5) / 256) / 8192, (dem.y + (y + 0.5) / 256) / 8192]);
      assert.ok(Math.abs(values[y * 256 + x]! - slope(lon, lat)) < 0.002, `slope at ${dem.x}/${dem.y}/${x}/${y}`);
    }
  }
});

test('surface and maximum caches cannot replace each other and warmed interpolation does not reread archives', async t => {
  const { read, calls } = fixture(t);
  const surface = await read(), maxima = await read(tile, false), before = calls.length;
  assert.ok(maxima.every(value => value === 12000));
  assert.ok(surface.every(value => value < 12000));
  assert.deepEqual(await read(), surface);
  assert.deepEqual(await read(tile, false), maxima);
  assert.equal(calls.length, before);
  assert.ok(calls.includes(true) && calls.includes(false));
});

test('interpolation leaves a gap when a contributing elevation is missing', async t => {
  const { read } = fixture(t, true);
  const surface = await read();
  assert.ok(Number.isNaN(surface[128 * 256 + 128]));
  assert.ok(Number.isFinite(surface[80 * 256 + 80]));
});

test('surface footprints include interpolation neighbors without wrapping across the date line', () => {
  for (const lng of [-179.9999, 179.9999]) {
    const [x, y] = project([lng, 37.89]);
    const dem = { z: 13, x: Math.floor(x * 8192), y: Math.floor(y * 8192) };
    const grids = geographicTiles(dem, 11, true);
    assert.ok(grids.length <= 6);
    assert.ok(grids.every(grid => lng < 0 ? grid.x < 2 : grid.x > 2000));
  }
});
