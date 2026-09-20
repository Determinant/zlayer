import { corridorOpacity, nmPerWorldUnit, unproject, type Point, type Segment, type Tile } from './geometry';
import { terrainColor, TERRAIN_FILL_OPACITY, TERRAIN_LINE_COLOR, TERRAIN_LINE_OPACITY } from './palette';
import { packedTerrainValue } from './clearance';

export type TerrainLabel = { coordinate: Point; elevation: number; opacity: number; peak: boolean };
export type PaintedTile = { pixels: Uint8ClampedArray; labels: TerrainLabel[]; incomplete: boolean };
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

/** Paint solid bands with screen-sized, high-contrast contour strokes. Overview
 * geometry remains simplified. Mask geometry is prepared once, with one square
 * root per cell (not one per segment) and one Mercator scale calculation per row. */
export function paintTerrain(values: Float32Array, tile: Tile, segments: readonly Segment[],
  interval: number, displayScale: number, size = 256, lines = true, indexed = false): PaintedTile {
  const pixels = new Uint8ClampedArray(size * size * 4);
  const labels: TerrainLabel[] = [];
  let incomplete = false;
  const usedLevels = new Set<number>();
  const worldSize = 2 ** tile.z;
  const prepared = segments.map(([a, b]) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    return { x: a[0], y: a[1], dx, dy, inverseLength: 1 / (dx * dx + dy * dy || 1) };
  });
  const bandColors = new Map<number, number[]>();
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
      // The base band is unshaded. Filling it paints a blanket over the whole
      // corridor, including water/lowlands, rather than distinct terrain regions.
      const filled = height >= interval;
      if (!filled && !lines && !indexed) continue;
      const level = Math.max(interval, Math.round(height / interval) * interval);
      const major = level % 1000 === 0;
      let line = 0, separation = 0;
      if (lines) {
        const left = values[y * size + Math.max(0, x - 1)]!;
        const right = values[y * size + Math.min(size - 1, x + 1)]!;
        const above = values[Math.max(0, y - 1) * size + x]!;
        const below = values[Math.min(size - 1, y + 1) * size + x]!;
        const gradient = Math.hypot((right - left) / 2, (below - above) / 2) / displayScale;
        separation = interval / Math.max(1, gradient);
        // A solid stroke center with a one-pixel antialiased edge keeps contours
        // legible between pixel centers. Narrow densely packed strokes, preserving
        // their contrast instead of fading them into the surrounding fill.
        const width = Math.min(major ? 2.4 : 1.5, Math.max(1, separation * 0.4));
        line = Number.isFinite(gradient) && gradient > 0.01
          ? Math.max(0, Math.min(1, width / 2 + 0.5 - Math.abs(height - level) / gradient)) : 0;
      }
      if (!filled && line === 0 && !indexed) continue;
      if (indexed) {
        const packed = packedTerrainValue(height, interval, opacity);
        pixels[i * 4] = packed >> 8;
        pixels[i * 4 + 1] = packed & 255;
        pixels[i * 4 + 3] = 255;
        continue;
      }
      const band = Math.max(0, Math.floor(height / interval)) * interval;
      let color = bandColors.get(band);
      if (!color) { color = terrainColor(band); bandColors.set(band, color); }
      for (let c = 0; c < 3; c++) pixels[i * 4 + c] = filled
        ? color[c]! * (1 - line) + TERRAIN_LINE_COLOR[c]! * line : TERRAIN_LINE_COLOR[c]!;
      const alpha = filled ? TERRAIN_FILL_OPACITY + line * (TERRAIN_LINE_OPACITY - TERRAIN_FILL_OPACITY)
        : line * TERRAIN_LINE_OPACITY;
      pixels[i * 4 + 3] = Math.round(alpha * opacity * 255);
      if (major && level > 0 && line > 0.7 && separation > 8 && opacity > 0.25 &&
        x > size / 10 && x < size * 0.9 && y > size / 10 && y < size * 0.9 && x % 8 === 0 && y % 8 === 0 && !usedLevels.has(level)) {
        usedLevels.add(level);
        labels.push({ coordinate: unproject([worldX, worldY]), elevation: level, opacity, peak: false });
      }
    }
  }
  return { pixels, labels, incomplete };
}
