import { isRecord, isSha256, isStrictBounds } from './validation.js';

export const AWC_GRID_FIELDS = {
  clouds: ['cloudCover', 'cloudBase', 'cloudTop', 'freezingLowest', 'freezingHighest'],
  icing: ['icingProbability', 'icingSeverity', 'sldPotential'],
  winds: ['windHeight', 'windEast', 'windNorth', 'temperature'],
} as const;
export type AwcGridProduct = keyof typeof AWC_GRID_FIELDS;
export type AwcGridField = (typeof AWC_GRID_FIELDS)[AwcGridProduct][number];
export const AWC_GRID_MODES = ['none', ...AWC_GRID_FIELDS.clouds, ...AWC_GRID_FIELDS.icing, 'temperature'] as const;
export type AwcGridMode = (typeof AWC_GRID_MODES)[number];
export const GRID_MISSING = -9999, GRID_BELOW_GROUND = -9998, GRID_UNKNOWN = -9997, GRID_OUTSIDE = -9996;
export const GRID_MAX_COMPRESSED_BYTES = 16 * 1024 * 1024;
export const GRID_MAX_DECODED_BYTES = 48 * 1024 * 1024;

export type AwcGridFrame = {
  validTime: number; altitudeFtMsl: number | null;
  /** Winds use an isobaric surface, never a nominal MSL altitude. */
  pressureHpa?: number;
  path: string; bytes: number; decodedBytes: number; sha256: string;
  /** Original GRIB URLs, plus immutable decoder provenance in the generation. */
  sources: string[];
};
export type AwcGridManifest = {
  schemaVersion: 1; product: AwcGridProduct; model: 'HRRR' | 'IFI';
  generation: string; runTime: number; checkedAt: number; publishedAt: number;
  cadenceMs: 3600000;
  /** Pixel edges in WGS84; samples are north-to-south rows on a Web Mercator grid. */
  grid: { projection: 'EPSG:3857'; width: number; height: number; bounds: [number, number, number, number] };
  fields: readonly AwcGridField[];
  frames: AwcGridFrame[];
};
const instant = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x > 0 && x < 8.64e15;
const integer = (x: unknown, lo: number, hi: number): x is number => typeof x === 'number' && Number.isInteger(x) && x >= lo && x <= hi;
const sourceUrl = (x: unknown): x is string => typeof x === 'string' && x.length < 2048 && /^https:\/\/(?:nomads\.ncep\.noaa\.gov|noaa-hrrr-bdp-pds\.s3\.amazonaws\.com)\//.test(x);

export function isAwcGridManifest(value: unknown): value is AwcGridManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || !['clouds', 'icing', 'winds'].includes(String(value.product))) return false;
  const fields = AWC_GRID_FIELDS[value.product as AwcGridProduct];
  if (value.model !== (value.product === 'icing' ? 'IFI' : 'HRRR') ||
    typeof value.generation !== 'string' || !/^[a-z0-9-]{16,96}$/.test(value.generation) ||
    !instant(value.runTime) || value.runTime % 3600000 !== 0 || !instant(value.checkedAt) || !instant(value.publishedAt) ||
    value.runTime > value.checkedAt || value.checkedAt > value.publishedAt || value.cadenceMs !== 3600000 ||
    !Array.isArray(value.fields) || value.fields.join(',') !== fields.join(',')) return false;
  const grid = value.grid;
  if (!isRecord(grid) || grid.projection !== 'EPSG:3857' || !integer(grid.width, 2, 4096) || !integer(grid.height, 2, 4096) ||
    !isStrictBounds(grid.bounds) || grid.bounds[0] < -180 || grid.bounds[2] > 180 || grid.bounds[1] < -85 || grid.bounds[3] > 85) return false;
  const decodedBytes = 16 + grid.width * grid.height * fields.length * 4;
  if (decodedBytes > GRID_MAX_DECODED_BYTES || !Array.isArray(value.frames) || !value.frames.length || value.frames.length > 1140) return false;
  const keys = new Set<string>(), paths = new Set<string>();
  for (const frame of value.frames) {
    if (!isRecord(frame) || !instant(frame.validTime) || frame.validTime < value.runTime + (value.product === 'icing' ? 3600000 : 0) ||
      frame.validTime > value.runTime + 18 * 3600000 || (frame.validTime - value.runTime) % 3600000 !== 0 ||
      (value.product === 'icing' ? !integer(frame.altitudeFtMsl, 500, 30000) || frame.altitudeFtMsl % 500 !== 0 : frame.altitudeFtMsl !== null) ||
      (value.product === 'winds' ? !integer(frame.pressureHpa, 100, 1000) || frame.pressureHpa % 25 !== 0 : frame.pressureHpa !== undefined) ||
      typeof frame.path !== 'string' || !frame.path.startsWith(`runs/${value.generation}/`) ||
      !/^runs\/[a-z0-9-]+\/[a-z0-9-]+\.zwg\.gz$/.test(frame.path) ||
      !integer(frame.bytes, 20, GRID_MAX_COMPRESSED_BYTES) || frame.decodedBytes !== decodedBytes || !isSha256(frame.sha256) ||
      !Array.isArray(frame.sources) || !frame.sources.length || frame.sources.length > 3 || !frame.sources.every(sourceUrl)) return false;
    const key = `${frame.validTime}/${frame.altitudeFtMsl}/${frame.pressureHpa}`;
    if (keys.has(key) || paths.has(frame.path)) return false;
    keys.add(key); paths.add(frame.path);
  }
  return true;
}

export function awcGridProduct(mode: AwcGridMode): AwcGridProduct | undefined {
  return mode === 'none' ? undefined : mode === 'temperature' ? 'winds' : (AWC_GRID_FIELDS.icing as readonly string[]).includes(mode) ? 'icing' : 'clouds';
}
