import { isRecord, isSha256 } from './validation.js';
import { RADAR_HISTORY_MS } from './radar-weather.js';

export const RADAR_MOTION_MAX_BYTES = 4 * 1024 * 1024;
export const RADAR_MOTION_ROOT = 'https://tgftp.nws.noaa.gov/SL.us008001/DF.of/DC.radar/DS.58sti/';
export type RadarCellTrack = { id: string; intervalMinutes: number; coordinates: [number, number][] };
export type RadarMotionScan = {
  site: string; observedAt: number; source: string; sourceHash: string; tracks: RadarCellTrack[];
};
export type RadarMotionSnapshot = { schemaVersion: 1; scans: RadarMotionScan[] };
/** availableAt is collection time, never a substitute for a scan's observation time. */
export type RadarMotionFile = { availableAt: number; path: string; sha256: string; byteLength: number };
export type RadarMotionCatalog = { schemaVersion: 1; checkedAt: number; files: RadarMotionFile[]; unavailable: string[] };
const instant = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v < 8.64e15;
const site = (v: unknown): v is string => typeof v === 'string' && /^K[A-Z]{3}$/.test(v);
const position = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 &&
  v.every(n => typeof n === 'number' && Number.isFinite(n)) && Math.abs(v[0]) <= 180 && Math.abs(v[1]) <= 90;
export function isRadarMotionSnapshot(v: unknown): v is RadarMotionSnapshot {
  let tracks = 0;
  return isRecord(v) && v.schemaVersion === 1 && Array.isArray(v.scans) && v.scans.length <= 160 &&
    v.scans.every(s => isRecord(s) && site(s.site) && instant(s.observedAt) && isSha256(s.sourceHash) &&
      s.source === `${RADAR_MOTION_ROOT}SI.${s.site.toLowerCase()}/sn.last` && Array.isArray(s.tracks) && s.tracks.length <= 100 &&
      (tracks += s.tracks.length) <= 10_000 && s.tracks.every(t => isRecord(t) && typeof t.id === 'string' && /^[A-Z][0-9]$/.test(t.id) &&
        typeof t.intervalMinutes === 'number' && t.intervalMinutes >= 5 && t.intervalMinutes <= 60 && t.intervalMinutes % 5 === 0 &&
        Array.isArray(t.coordinates) && t.coordinates.length >= 2 && t.coordinates.length <= 5 && t.coordinates.every(position)) &&
      new Set(s.tracks.map(t => t.id)).size === s.tracks.length) && new Set(v.scans.map(s => s.site)).size === v.scans.length;
}
export function isRadarMotionCatalog(v: unknown): v is RadarMotionCatalog {
  if (!isRecord(v) || v.schemaVersion !== 1 || !instant(v.checkedAt) || !Array.isArray(v.files) || v.files.length > 26 ||
    !Array.isArray(v.unavailable) || v.unavailable.length > 160 || !v.unavailable.every(site) || new Set(v.unavailable).size !== v.unavailable.length) return false;
  const checked = v.checkedAt;
  return v.files.every(f => isRecord(f) && instant(f.availableAt) && f.availableAt <= checked && f.availableAt >= checked - RADAR_HISTORY_MS &&
    isSha256(f.sha256) && f.path === `motion/${f.sha256}.json` && typeof f.byteLength === 'number' && Number.isSafeInteger(f.byteLength) &&
    f.byteLength > 0 && f.byteLength <= RADAR_MOTION_MAX_BYTES) && v.files.every((f, i, files) => !i || f.availableAt > files[i - 1].availableAt);
}
