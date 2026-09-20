import { corridorDistance, INNER_NM, unproject, type Point, type Segment, type Tile } from './geometry';
import type { TerrainLabel } from './contours';

/** Max pooling removes subpixel detail without averaging away sampled ridges.
 * Any unknown sample leaves its display cell unknown, never falsely low/clear. */
export function simplifyElevation(values: Float32Array, sourceSize: number, targetSize: number): Float32Array {
  if (targetSize === sourceSize) return values;
  if (targetSize > sourceSize || sourceSize % targetSize !== 0) throw new Error('Invalid terrain grid size');
  const step = sourceSize / targetSize;
  const result = new Float32Array(targetSize * targetSize).fill(-Infinity);
  for (let y = 0; y < sourceSize; y++) {
    const row = Math.floor(y / step) * targetSize;
    for (let x = 0; x < sourceSize; x++) {
      const index = row + Math.floor(x / step);
      result[index] = Math.max(result[index]!, values[y * sourceSize + x]!);
    }
  }
  return result;
}

/** Interpolate geometry, not already-painted colors/alpha. Quantizing the result
 * yields solid regions with crisp contour boundaries, even with a coarse grid. */
export function interpolateElevation(values: Float32Array, sourceSize: number, targetSize: number): Float32Array {
  if (sourceSize === targetSize) return values;
  const result = new Float32Array(targetSize * targetSize);
  const scale = sourceSize / targetSize;
  for (let y = 0; y < targetSize; y++) {
    const sy = Math.max(0, Math.min(sourceSize - 1, (y + 0.5) * scale - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(sourceSize - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < targetSize; x++) {
      const sx = Math.max(0, Math.min(sourceSize - 1, (x + 0.5) * scale - 0.5));
      const x0 = Math.floor(sx), x1 = Math.min(sourceSize - 1, x0 + 1), fx = sx - x0;
      const a = values[y0 * sourceSize + x0]!, b = values[y0 * sourceSize + x1]!;
      const c = values[y1 * sourceSize + x0]!, d = values[y1 * sourceSize + x1]!;
      result[y * targetSize + x] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
  }
  return result;
}

/** Read original samples for high labels; only candidates exceeding the current
 * high need a corridor calculation. Simplifying the picture cannot move a peak. */
export function sampledHigh(values: Float32Array, tile: Tile, segments: readonly Segment[], size = 256): TerrainLabel | undefined {
  if (!segments.length) return undefined;
  let high = -Infinity, coordinate: Point | undefined;
  const scale = 2 ** tile.z;
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!;
    if (!Number.isFinite(value) || value <= high) continue;
    const point: Point = [(tile.x + (i % size + 0.5) / size) / scale, (tile.y + (Math.floor(i / size) + 0.5) / size) / scale];
    if (corridorDistance(point, segments) > INNER_NM) continue;
    high = value; coordinate = unproject(point);
  }
  return coordinate ? { coordinate, elevation: high, opacity: 1, peak: true } : undefined;
}
