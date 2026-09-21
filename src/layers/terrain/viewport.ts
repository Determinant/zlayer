import type { ExpressionSpecification } from 'maplibre-gl';
import { CLEARANCE_COLORS } from './clearance';
import { TERRAIN_COLOR_STOPS, TERRAIN_FILL_OPACITY, terrainColor } from './palette';

// Integer feet, rounded upward by less than one foot. Zero encodes missing data;
// the offset accommodates the full supported terrain range, including ocean floors.
export const VIEWPORT_ELEVATION_OFFSET = 40000;
export const VIEWPORT_MIN_ZOOM = 0;

/** Copy native samples without smoothing away ridges or running corridor geometry.
 * At the maximum DEM zoom, nearest expansion preserves the same native samples. */
export function viewportPixels(values: Float32Array, size = 256, sourceSize = 256) {
  const pixels = new Uint8ClampedArray(size * size * 4);
  let incomplete = false;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const height = values[Math.floor(y * sourceSize / size) * sourceSize + Math.floor(x * sourceSize / size)]!;
    const valid = Number.isFinite(height) && height >= -12000 / 0.3048 && height <= 10000 / 0.3048;
    const packed = valid ? Math.ceil(height) + VIEWPORT_ELEVATION_OFFSET : 0;
    incomplete ||= !valid;
    const i = (y * size + x) * 4;
    pixels[i] = packed >>> 16;
    pixels[i + 1] = (packed >>> 8) & 255;
    pixels[i + 2] = packed & 255;
    pixels[i + 3] = 255;
  }
  return { pixels, incomplete };
}

/** Adjacent integer stops give exact clearance categories on integer-foot textures.
 * The transparent sentinel survives every altitude; no colored pixels are blurred. */
export function viewportPalette(altitude: number | null, interval: number): ExpressionSpecification {
  const transparent = 'rgba(0,0,0,0)';
  const ramp: ExpressionSpecification = ['interpolate', ['linear'], ['elevation'], -VIEWPORT_ELEVATION_OFFSET, transparent];
  if (altitude === null) {
    ramp.push(interval - 1, transparent, interval, `rgba(${terrainColor(interval).join(',')},${TERRAIN_FILL_OPACITY})`);
    for (const stop of TERRAIN_COLOR_STOPS) if (stop.feet > interval) {
      ramp.push(stop.feet, `rgba(${terrainColor(stop.feet).join(',')},${TERRAIN_FILL_OPACITY})`);
    }
  } else {
    const color = (hex: string) => `rgba(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(',')},${TERRAIN_FILL_OPACITY})`;
    ramp.push(altitude - 2000, transparent,
      altitude - 1999, color(CLEARANCE_COLORS.below), altitude - 1000, color(CLEARANCE_COLORS.below),
      altitude - 999, color(CLEARANCE_COLORS.near), altitude - 500, color(CLEARANCE_COLORS.near),
      altitude - 499, color(CLEARANCE_COLORS.close), altitude - 1, color(CLEARANCE_COLORS.close),
      altitude, color(CLEARANCE_COLORS.above));
  }
  return ramp;
}
