import { corridorOpacity, nmPerWorldUnit, type Point, type Segment, type Tile } from './geometry';
import { packedTerrainValue } from './clearance';

export type TerrainLabel = { coordinate: Point; elevation: number; opacity: number; peak: boolean };
export type PaintedTile = { pixels: Uint8ClampedArray; incomplete: boolean };
export const METERS_TO_FEET = 1 / 0.3048;

export function decodeTerrarium(rgba: Uint8ClampedArray): Float32Array {
  const values = new Float32Array(rgba.length / 4);
  for (let i = 0; i < values.length; i++) {
    values[i] = rgba[i * 4 + 3] === 0 ? NaN
      : (rgba[i * 4]! * 256 + rgba[i * 4 + 1]! + rgba[i * 4 + 2]! / 256 - 32768) * METERS_TO_FEET;
    // Reject sentinel/invalid values outside the physical range of Earth terrain.
    if (values[i]! < -12000 * METERS_TO_FEET || values[i]! > 10000 * METERS_TO_FEET) values[i] = NaN;
  }
  return values;
}

/** Encode band indices and corridor opacity for the GPU palette. Contour strokes
 * and labels are generated separately by terrainIsolines. Mask geometry is prepared
 * once, with one square root per cell and one Mercator scale calculation per row. */
export function paintTerrain(values: Float32Array, tile: Tile, segments: readonly Segment[],
  interval: number, size = 256): PaintedTile {
  const pixels = new Uint8ClampedArray(size * size * 4);
  let incomplete = false;
  const worldSize = 2 ** tile.z;
  const prepared = segments.map(([a, b]) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    return { x: a[0], y: a[1], dx, dy, inverseLength: 1 / (dx * dx + dy * dy || 1) };
  });
  for (let y = 0; y < size; y++) {
    const worldY = (tile.y + (y + 0.5) / size) / worldSize;
    const nmScale = nmPerWorldUnit(worldY);
    for (let x = 0; x < size; x++) {
      const i = y * size + x, height = values[i]!;
      const worldX = (tile.x + (x + 0.5) / size) / worldSize;
      let distanceSquared = Infinity;
      for (const segment of prepared) {
        const dx = worldX - segment.x, dy = worldY - segment.y;
        const t = Math.max(0, Math.min(1, (dx * segment.dx + dy * segment.dy) * segment.inverseLength));
        distanceSquared = Math.min(distanceSquared, (dx - t * segment.dx) ** 2 + (dy - t * segment.dy) ** 2);
      }
      const opacity = corridorOpacity(Math.sqrt(distanceSquared) * nmScale);
      if (opacity === 0) continue;
      // Downloaded tiles extend beyond the route. Only missing samples in the
      // painted corridor (including gaps spread by interpolation) are incomplete.
      if (!Number.isFinite(height)) { incomplete = true; continue; }
      const packed = packedTerrainValue(height, interval, opacity);
      pixels[i * 4] = packed >> 8;
      pixels[i * 4 + 1] = packed & 255;
      pixels[i * 4 + 3] = 255;
    }
  }
  return { pixels, incomplete };
}
