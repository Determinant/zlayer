import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { packedTerrainValue } from '../src/layers/terrain/clearance';
import { terrainDetail } from '../src/layers/terrain/detail';
import { geographicTiles } from '../src/layers/terrain/geographic';
import { project, type Tile, type Segment } from '../src/layers/terrain/geometry';
import type { TerrainPackage } from '../src/layers/terrain/packages';
import type { TerrainWorker } from '../src/layers/terrain/types';
import { stitchTerrainContours } from '../src/layers/terrain/seams';

// Exercise the real worker's fill/contour/peak pipeline. Only archive input and
// browser canvas/Comlink boundaries are replaced; both elevation channels differ.
const runtime = {
  worker: undefined as TerrainWorker | undefined,
  read: (_tile: Tile, _url: string, _signal: AbortSignal, _source: unknown, _surface = false): Float32Array => { throw new Error('Missing fixture'); },
  context(width: number, height: number) {
    const pixels = new Uint8ClampedArray(width * height * 4);
    return {
      canvas: { width, height, transferToImageBitmap: () => ({ pixels, width, height }) },
      putImageData(image: ImageData, left: number, top: number) {
        for (let y = 0; y < image.height; y++) pixels.set(image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4),
          ((top + y) * width + left) * 4);
      },
    };
  },
};
Object.defineProperty(globalThis, 'terrainWorkerTest', { configurable: true, value: runtime });
Object.defineProperty(globalThis, 'ImageData', { configurable: true,
  value: class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} } });
const loader = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/terrain/terrain.worker.ts')) {
    const source = specifier === 'comlink' ? 'export const expose = value => globalThis.terrainWorkerTest.worker = value; export const transfer = value => value;'
      : specifier === './elevation' ? 'export class ElevationTiles { read(...args) { return globalThis.terrainWorkerTest.read(...args); } }'
      : specifier.endsWith('/pixel-context') ? 'export const createPixelContext = (...args) => globalThis.terrainWorkerTest.context(...args);' : undefined;
    if (source) return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(source) };
  }
  return next(specifier, context);
} });
await import('../src/layers/terrain/terrain.worker');
loader.deregister();
test.after(() => { Reflect.deleteProperty(globalThis, 'terrainWorkerTest'); Reflect.deleteProperty(globalThis, 'ImageData'); });

for (const zoom of [9, 11, 13]) test(`route fill boundaries follow surface contours and retain sampled highs at zoom ${zoom}`, async () => {
  const center = project([-119.66734166, 37.89044722]), scale = 2 ** zoom;
  const tile = { z: zoom, x: Math.floor(center[0] * scale), y: Math.floor(center[1] * scale) };
  const segments: Segment[] = [[[(tile.x - 1) / scale, (tile.y + 0.5) / scale], [(tile.x + 2) / scale, (tile.y + 0.5) / scale]]];
  const { demZoom, interval } = terrainDetail(zoom), factor = 2 ** (demZoom - zoom);
  const packages: TerrainPackage[] = [];
  for (let y = 0; y < factor; y++) for (let x = 0; x < factor; x++) {
    for (const grid of geographicTiles({ z: demZoom, x: tile.x * factor + x, y: tile.y * factor + y }, 11, true)) {
      packages.push({ root: 'https://terrain.test', grid: 'EPSG:4326', maxZoom: 11,
        shard: { zoom: grid.z, x: Math.floor(grid.x / 64) * 64, y: Math.floor(grid.y / 64) * 64,
          file: `${'a'.repeat(64)}.terrain`, sha256: 'a'.repeat(64), byteLength: 100 } });
    }
  }
  runtime.read = (dem, _url, signal, _sources, surface) => {
    signal.throwIfAborted();
    return Float32Array.from({ length: 256 * 256 }, (_, i) => {
      const x = (dem.x + (i % 256 + 0.5) / 256) / factor - tile.x;
      return 3000 + x * 2000 + (surface ? 0 : 1500);
    });
  };
  const result = await runtime.worker!.render({ id: zoom, tile, segments, tileUrl: '', packages, coverage: 'route' });
  const { pixels } = result.data as unknown as { pixels: Uint8ClampedArray };
  const pixel = (x: number) => pixels[(256 * 512 + x) * 4]! * 256 + pixels[(256 * 512 + x) * 4 + 1]!;
  assert.equal(pixel(250), packedTerrainValue(3990, interval, 1), 'low side must use the same surface as the 4,000 ft contour');
  assert.equal(pixel(261), packedTerrainValue(4010, interval, 1), 'high side must enter the next contour band');
  const contour = stitchTerrainContours(result.lines, result.borders!, segments).filter(line => line.elevation === 4000);
  assert.ok(contour.length > 0);
  for (const line of contour) for (const path of line.coordinates) for (const point of path) {
    assert.ok(Math.abs((project(point)[0] * scale - tile.x) * 512 - 256) < 0.01);
  }
  assert.ok(result.labels.some(label => label.peak && label.elevation > 6400), 'sampled highs retain the maximum channel');
  assert.equal(result.incomplete, false);
});
