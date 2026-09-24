import { isRecord, isSha256 } from './validation.js';

export const RADAR_MAX_BYTES = 16 * 1024 * 1024;
export const RADAR_MAX_AGE = 15 * 60_000;
export const RADAR_HISTORY_MS = 2 * 3600_000;
export const RADAR_HISTORY_STEP = 5 * 60_000;
export const RADAR_HISTORY_FILES = 1200;
export const RADAR_LEVELS = [5, 15, 25, 35, 45, 55, 65, 75] as const;
export type RadarScan = {
  site: string; observedAt: number; source: string; sourceHash: string;
  bounds: [number, number, number, number];
};
export type RadarFile = RadarScan & { path: string; sha256: string; byteLength: number };
export type RadarCatalog = { schemaVersion: 1; checkedAt: number; files: RadarFile[]; unavailable: string[]; history?: RadarFile[] };
export type RadarFeature = { type: 'Feature'; properties: { dbz: number }; geometry: { type: 'MultiPolygon'; coordinates: number[][][][] } };
export type RadarContours = RadarScan & { schemaVersion: 1; type: 'FeatureCollection'; features: RadarFeature[] };
const instant = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v < 8.64e15;
const site = (v: unknown): v is string => typeof v === 'string' && /^(CONUS|T[A-Z]{3})$/.test(v);
const position = (v: unknown): v is number[] => Array.isArray(v) && v.length === 2 &&
  v.every(n => typeof n === 'number' && Number.isFinite(n)) && Math.abs(v[0]) <= 180 && Math.abs(v[1]) <= 90;
function scan(v: unknown): v is RadarScan & Record<string, unknown> {
  return isRecord(v) && site(v.site) && instant(v.observedAt) && isSha256(v.sourceHash) && typeof v.source === 'string' &&
    (v.site === 'CONUS' ? /^https:\/\/noaa-mrms-pds\.s3\.amazonaws\.com\/CONUS\/MergedReflectivityQCComposite_00\.50\/\d{8}\/MRMS_MergedReflectivityQCComposite_00\.50_\d{8}-\d{6}\.grib2\.gz$/.test(v.source)
      : v.source === `https://tgftp.nws.noaa.gov/SL.us008001/DF.of/DC.radar/DS.180z0/SI.${v.site.toLowerCase()}/sn.last`) &&
    Array.isArray(v.bounds) && v.bounds.length === 4 && position(v.bounds.slice(0, 2)) && position(v.bounds.slice(2)) && v.bounds[0] < v.bounds[2] && v.bounds[1] < v.bounds[3];
}
export function isRadarCatalog(v: unknown): v is RadarCatalog {
  if (!isRecord(v) || v.schemaVersion !== 1 || !instant(v.checkedAt) || !Array.isArray(v.files) || !v.files.length || v.files.length > 50 ||
    !Array.isArray(v.unavailable) || v.unavailable.length > 50 || !v.unavailable.every(site)) return false;
  const checked = v.checkedAt;
  const file = (f: unknown): f is RadarFile => isRecord(f) && scan(f) && f.observedAt <= checked + 60_000 && isSha256(f.sha256) &&
    f.path === `${f.site}/${f.observedAt}-${f.sha256}.json` && typeof f.byteLength === 'number' && Number.isSafeInteger(f.byteLength) && f.byteLength > 0 && f.byteLength <= RADAR_MAX_BYTES;
  return new Set(v.files.map(f => isRecord(f) ? f.site : undefined)).size === v.files.length && v.files.some(f => isRecord(f) && f.site === 'CONUS') &&
    v.files.every(file) && (v.history === undefined || Array.isArray(v.history) && v.history.length <= RADAR_HISTORY_FILES &&
      v.history.every(f => file(f) && f.observedAt >= checked - RADAR_HISTORY_MS) &&
      new Set(v.history.map(f => `${f.site}/${f.observedAt}`)).size === v.history.length);
}
export function isRadarContours(v: unknown): v is RadarContours {
  if (!isRecord(v) || !scan(v) || v.schemaVersion !== 1 || v.type !== 'FeatureCollection' || !Array.isArray(v.features) || v.features.length !== RADAR_LEVELS.length) return false;
  let count = 0;
  return v.features.every((f: unknown, i) => isRecord(f) && f.type === 'Feature' && isRecord(f.properties) && f.properties.dbz === RADAR_LEVELS[i] &&
    isRecord(f.geometry) && f.geometry.type === 'MultiPolygon' && Array.isArray(f.geometry.coordinates) && f.geometry.coordinates.length <= 100_000 &&
    f.geometry.coordinates.every((polygon: unknown) => Array.isArray(polygon) && polygon.length > 0 && polygon.length <= 10_000 &&
      polygon.every((ring: unknown) => Array.isArray(ring) && ring.length >= 4 && (count += ring.length) <= 1_000_000 && ring.every(position) &&
        ring[0]![0] === ring.at(-1)![0] && ring[0]![1] === ring.at(-1)![1])));
}
