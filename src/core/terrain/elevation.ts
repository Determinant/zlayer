import { project, type Tile } from '../geo/route-corridor';
import type { Bounds } from '@zlayer/contracts';
import type { ElevationTilePool } from './elevation-pool';

/** Elevations are feet MSL; non-finite samples always mean unknown ground. */
export type ElevationReader = (tile: Tile, signal: AbortSignal) => Promise<Float32Array>;
export type ElevationGrid = { values: Float32Array; width: number; height: number; x: number; y: number; size: number };

export function elevationGridLayout(bounds: Bounds, zoom: number): Omit<ElevationGrid, 'values'> {
  const size = 256 * 2 ** zoom;
  const nw = project([bounds[0], bounds[3]]), se = project([bounds[2], bounds[1]]);
  const x = Math.floor(nw[0] * size), y = Math.max(0, Math.floor(nw[1] * size));
  return { size, x, y, width: Math.ceil(se[0] * size) - x, height: Math.min(size, Math.ceil(se[1] * size)) - y };
}

/** Bounded, maximum-height DEM mosaic. The provider owns source identity and caching.
 * Longitudes may be unwrapped; requests wrap while returned geometry stays local.
 * Optional pooling changes output/mask resolution, never source acquisition zoom.
 * Whole aligned source-cell blocks are maximized before copying into the mosaic. */
export async function readElevationGrid(read: ElevationReader, bounds: Bounds, zoom: number, signal: AbortSignal,
  mask?: Uint8Array, pooling?: { factor: number; tiles: ElevationTilePool }): Promise<ElevationGrid> {
  const factor = pooling?.factor ?? 1;
  if (factor < 1 || factor > 256 || !Number.isInteger(Math.log2(factor))) throw new Error('Invalid elevation pooling factor');
  const native = elevationGridLayout(bounds, zoom);
  if (native.width * native.height > 1024 * 1024) throw new Error('Elevation area is too large');
  const { size, x, y, width, height } = elevationGridLayout(bounds, zoom - Math.log2(factor));
  const tileWidth = 256 / factor;
  if (mask && mask.length !== width * height) throw new Error('Invalid elevation mask');
  if (width <= 0 || height <= 0 || width * height > 1024 * 1024) throw new Error('Elevation area is too large');
  const values = new Float32Array(width * height).fill(NaN);
  const tiles: Tile[] = [];
  for (let ty = Math.floor(y / tileWidth); ty <= Math.floor((y + height - 1) / tileWidth); ty++) {
    for (let tx = Math.floor(x / tileWidth); tx <= Math.floor((x + width - 1) / tileWidth); tx++) tiles.push({ z: zoom, x: tx, y: ty });
  }
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, tiles.length) }, async () => {
    while (next < tiles.length) {
      signal.throwIfAborted();
      const tile = tiles[next++]!, n = 2 ** zoom;
      const left = Math.max(x, tile.x * tileWidth), right = Math.min(x + width, (tile.x + 1) * tileWidth);
      const top = Math.max(y, tile.y * tileWidth), bottom = Math.min(y + height, (tile.y + 1) * tileWidth);
      if (mask) {
        let needed = false;
        for (let row = top; row < bottom && !needed; row++) for (let col = left; col < right; col++) {
          if (mask[(row - y) * width + col - x]) { needed = true; break; }
        }
        if (!needed) continue;
      }
      let data: Float32Array;
      try { data = await read({ ...tile, x: ((tile.x % n) + n) % n }, signal); }
      catch { signal.throwIfAborted(); continue; }
      signal.throwIfAborted();
      if (data.length !== 65536) continue;
      if (pooling) data = pooling.tiles.maximum(data, factor);
      for (let row = top; row < bottom; row++) {
        if (!mask) values.set(data.subarray((row - tile.y * tileWidth) * tileWidth + left - tile.x * tileWidth,
          (row - tile.y * tileWidth) * tileWidth + right - tile.x * tileWidth), (row - y) * width + left - x);
        else for (let col = left; col < right; col++) {
          const index = (row - y) * width + col - x;
          if (mask[index]) values[index] = data[(row - tile.y * tileWidth) * tileWidth + col - tile.x * tileWidth]!;
        }
      }
    }
  }));
  return { values, width, height, x, y, size };
}
