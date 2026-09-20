export const DEFAULT_TERRAIN_ALTITUDE = 4500;
export const MAX_TERRAIN_ALTITUDE = 25000;
export const TERRAIN_ALTITUDE_STEP = 100;
export const CLEARANCE_CUTOFF = 2000;

// Deliberately describes the difference to a selected MSL altitude, not an
// aircraft position or a guarantee of obstacle/route clearance.
export const CLEARANCE_COLORS = {
  above: '#ed443e', close: '#ff9826', near: '#ffd42a', below: '#83bd71', far: '#00000000',
} as const;

export function clearanceColor(clearance: number): string {
  return clearance <= 0 ? CLEARANCE_COLORS.above : clearance < 500 ? CLEARANCE_COLORS.close
    : clearance < 1000 ? CLEARANCE_COLORS.near : clearance < CLEARANCE_CUTOFF ? CLEARANCE_COLORS.below : CLEARANCE_COLORS.far;
}

export function displayElevation(elevation: number, peak: boolean): number {
  return peak ? Math.ceil(elevation / 100) * 100 : elevation;
}

export function clearanceText(altitude: number, elevation: number): string {
  const difference = altitude - elevation;
  return `${difference < 0 ? '−' : '+'}${Math.abs(difference).toLocaleString('en-US')} ft`;
}

/** Packed tile values are palette indices, not elevation DEMs for 3D terrain.
 * High byte: contour band's upper elevation, in 500 ft units with an offset.
 * Low byte: corridor opacity. Zero is reserved for missing/outside coverage. */
export const BAND_OFFSET = 128;
export const BAND_UNIT = 500;
export function packedTerrainValue(height: number, interval: number, opacity: number): number {
  if (!Number.isFinite(height) || opacity <= 0) return 0;
  const top = (Math.floor(height / interval) + 1) * interval;
  const band = Math.max(1, Math.min(255, top / BAND_UNIT + BAND_OFFSET));
  return band * 256 + Math.round(Math.max(0, Math.min(1, opacity)) * 255);
}
