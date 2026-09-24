import { GRID_BELOW_GROUND, GRID_MISSING, GRID_OUTSIDE, GRID_UNKNOWN, type AwcGridField, type AwcGridManifest } from '@zlayer/contracts';
import type { LambertGrid } from './grib';

/** Exact spherical Lambert transform for qualified HRRR/IFI grids; nearest cell only. */
export function samplingMap(source: LambertGrid, target: AwcGridManifest['grid']): Int32Array {
  const rad = Math.PI / 180, earth = 6371229;
  const tan = (lat: number) => Math.tan(Math.PI / 4 + lat * rad / 2);
  const p1 = source.parallel1 * rad, p2 = source.parallel2 * rad;
  const n = p1 === p2 ? Math.sin(p1) : Math.log(Math.cos(p1) / Math.cos(p2)) / Math.log(tan(source.parallel2) / tan(source.parallel1));
  const scale = earth * Math.cos(p1) * tan(source.parallel1) ** n / n;
  const origin = scale / tan(source.originLatitude) ** n, startRho = scale / tan(source.latitude) ** n;
  const startTheta = n * (source.longitude - source.meridian) * rad;
  const x0 = startRho * Math.sin(startTheta), y0 = origin - startRho * Math.cos(startTheta);
  const { width, height, bounds: [west, south, east, north] } = target;
  const sin = new Float64Array(width), cos = new Float64Array(width);
  for (let x = 0; x < width; x++) {
    const theta = n * (west + (x + 0.5) / width * (east - west) - source.meridian) * rad;
    sin[x] = Math.sin(theta); cos[x] = Math.cos(theta);
  }
  const top = Math.log(tan(north)), bottom = Math.log(tan(south));
  const indices = new Int32Array(width * height); indices.fill(-1);
  for (let y = 0; y < height; y++) {
    const rho = scale / Math.exp(n * (top + (y + 0.5) / height * (bottom - top)));
    for (let x = 0; x < width; x++) {
      const sx = Math.round((rho * sin[x]! - x0) / source.dx), sy = Math.round((origin - rho * cos[x]! - y0) / source.dy);
      if (sx >= 0 && sx < source.width && sy >= 0 && sy < source.height) indices[y * width + x] = sy * source.width + sx;
    }
  }
  return indices;
}
// Match the qualified Python/numpy conversion, including round-to-even at ties.
const rounded = (n: number) => { const floor = Math.floor(n), fraction = n - floor; return fraction === 0.5 ? floor + (floor & 1) : Math.round(n); };
export function convertValue(field: AwcGridField, value: number): number {
  if (Number.isNaN(value)) return GRID_MISSING;
  if (!Number.isFinite(value)) throw new Error('Non-finite NOAA sample');
  if (field === 'temperature') {
    if (value < 130 || value > 350) throw new Error('Unexpected NOAA temperature scale');
    return Math.round((value - 273.15) * 10) / 10;
  }
  if (field === 'windEast' || field === 'windNorth') {
    if (Math.abs(value) > 200) throw new Error('Unexpected NOAA wind scale');
    return value * 1.9438444924406048;
  }
  if (field === 'icingSeverity') return Number.isInteger(value) && value >= 0 && value <= 4 ? value : GRID_UNKNOWN;
  if (field === 'sldPotential') {
    if (value > 1) throw new Error('Unexpected NOAA SLD scale');
    return value < 0 ? GRID_UNKNOWN : rounded(Math.fround(value * 100)) / 100;
  }
  if (field === 'icingProbability' || field === 'cloudCover') {
    if (value < 0 || value > (field === 'cloudCover' ? 100 : 1)) throw new Error('Unexpected NOAA percentage scale');
    return rounded(field === 'cloudCover' ? value : Math.fround(value * 100));
  }
  const feet = rounded(Math.fround(Math.fround(value / 0.3048) / 10)) * 10;
  if (feet < -1500 || feet > 100000) throw new Error('Unexpected NOAA height scale');
  return feet;
}

/** Rotate at the actual nearest source cell, not its resampled display position. */
export function rotateWinds(grid: LambertGrid, indices: Int32Array, east: Float32Array, north: Float32Array): void {
  const rad = Math.PI / 180, tan = (lat: number) => Math.tan(Math.PI / 4 + lat * rad / 2);
  const p1 = grid.parallel1 * rad, p2 = grid.parallel2 * rad;
  const n = p1 === p2 ? Math.sin(p1) : Math.log(Math.cos(p1) / Math.cos(p2)) / Math.log(tan(grid.parallel2) / tan(grid.parallel1));
  const scale = 6371229 * Math.cos(p1) * tan(grid.parallel1) ** n / n;
  const rho = scale / tan(grid.latitude) ** n, theta = n * (grid.longitude - grid.meridian) * rad;
  const x0 = rho * Math.sin(theta), r0 = rho * Math.cos(theta);
  for (let i = 0; i < indices.length; i++) {
    const u = east[i]!, v = north[i]!;
    if (u <= GRID_OUTSIDE || v <= GRID_OUTSIDE) { east[i] = north[i] = u <= GRID_OUTSIDE ? u : v; continue; }
    const at = indices[i]!, x = x0 + (at % grid.width) * grid.dx, r = r0 - Math.floor(at / grid.width) * grid.dy;
    const length = Math.hypot(x, r), sin = grid.gridRelative ? x / length : 0, cos = grid.gridRelative ? r / length : 1;
    east[i] = Math.round((u * cos + v * sin) * 10) / 10;
    north[i] = Math.round((-u * sin + v * cos) * 10) / 10;
  }
}

export function projectField(field: AwcGridField, source: Float32Array, indices: Int32Array, target: Float32Array,
  terrain?: Float32Array, altitude?: number, probability?: Float32Array): void {
  for (let i = 0; i < indices.length; i++) {
    const at = indices[i]!;
    target[i] = at < 0 ? GRID_OUTSIDE : terrain && altitude !== undefined && Number.isNaN(terrain[i]) ? GRID_MISSING
      : terrain && altitude !== undefined && terrain[i]! > altitude * 0.3048 ? GRID_BELOW_GROUND
      : field === 'icingSeverity' && probability?.[i] === GRID_MISSING ? GRID_MISSING : convertValue(field, source[at]!);
  }
}
