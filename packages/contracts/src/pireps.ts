import { isRecord } from './validation.js';

export const PIREP_MAX_AGE_MS = 90 * 60_000;
export const PIREP_SOURCE_MAX_AGE_MS = 10 * 60_000;
export const PIREP_MAX_BYTES = 16 * 1024 * 1024;
export const PIREP_MAX_XML_BYTES = 8 * 1024 * 1024;
export const PIREP_MAX_RECORDS = 10_000;
/** Complete source delivery. Entries retain their XML, order and duplicates. */
export type PirepSourceSnapshot = {
  schemaVersion: 2; checkedAt: number; source: string; records: string[];
};
export type AircraftReport = {
  id: string; observedAt: number; receivedAt: number | null;
  longitude: number; latitude: number; altitudeFt: number | null;
  type: string; urgent: boolean; aircraft: string;
  turbulence: string[]; icing: string[]; sky: string[];
  quality: string[]; text: string; sourceXml: string;
  /** PWA recovered the observation time from /TM; source flags/XML stay intact. */
  timeSource?: 'raw';
};
/** Valid observation fields retained when the source cannot supply a usable point. */
export type UnlocatedAircraftReport = Omit<AircraftReport, 'longitude' | 'latitude' | 'sourceXml'>;
/** PWA interpretation; also the legacy schema-1 server response. */
export type PirepSnapshot = {
  schemaVersion: 1; checkedAt: number; source: string;
  reports: AircraftReport[];
  issues: { id: string; reason: string; sourceXml: string; qualityFlag?: 'bad_location' | 'no_time_stamp'; report?: UnlocatedAircraftReport;
    /** Untrusted source position: may corroborate a named reference, never plot directly. */
    sourceCoordinate?: [longitude: number, latitude: number] }[];
};
const text = (v: unknown): v is string => typeof v === 'string' && v.length <= 20_000;
const instant = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v < 8.64e15;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 100 && v.every(text);
export function isPirepSourceSnapshot(v: unknown): v is PirepSourceSnapshot {
  if (!isRecord(v) || v.schemaVersion !== 2 || !instant(v.checkedAt) || !text(v.source) || !v.source ||
    !Array.isArray(v.records) || v.records.length > PIREP_MAX_RECORDS) return false;
  let size = 0;
  return v.records.every(record => typeof record === 'string' && !!record && (size += record.length) <= PIREP_MAX_XML_BYTES);
}
export type PirepPayload = PirepSourceSnapshot | PirepSnapshot;
export function isPirepPayload(v: unknown): v is PirepPayload {
  return isPirepSourceSnapshot(v) || isPirepSnapshot(v);
}
function isObservation(v: unknown): v is UnlocatedAircraftReport {
  return isRecord(v) && text(v.id) && /^[a-f0-9]{64}$/.test(v.id) && instant(v.observedAt) &&
    (v.timeSource === undefined || v.timeSource === 'raw') &&
    (v.receivedAt === null || instant(v.receivedAt)) &&
    (v.altitudeFt === null || typeof v.altitudeFt === 'number' && Number.isInteger(v.altitudeFt) && v.altitudeFt >= -2000 && v.altitudeFt <= 100_000) &&
    text(v.type) && !!v.type.trim() && typeof v.urgent === 'boolean' && v.urgent === (v.type === 'Urgent PIREP') &&
    text(v.aircraft) && strings(v.turbulence) && strings(v.icing) && strings(v.sky) && strings(v.quality) &&
    text(v.text) && !!v.text.trim();
}
export function isUnlocatedAircraftReport(v: unknown): v is UnlocatedAircraftReport {
  return isObservation(v) && !('longitude' in v) && !('latitude' in v) && !('sourceXml' in v);
}
export function isAircraftReport(v: unknown): v is AircraftReport {
  return isObservation(v) && 'sourceXml' in v && text(v.sourceXml) && !!v.sourceXml && 'longitude' in v && 'latitude' in v &&
    typeof v.longitude === 'number' && Number.isFinite(v.longitude) && Math.abs(v.longitude) <= 180 &&
    typeof v.latitude === 'number' && Number.isFinite(v.latitude) && Math.abs(v.latitude) <= 90;
}
export function isPirepSnapshot(v: unknown): v is PirepSnapshot {
  const checkedAt = isRecord(v) ? v.checkedAt : undefined;
  return isRecord(v) && v.schemaVersion === 1 && instant(checkedAt) && text(v.source) && !!v.source &&
    Array.isArray(v.reports) && Array.isArray(v.issues) && v.reports.length + v.issues.length <= PIREP_MAX_RECORDS &&
    v.reports.every(isAircraftReport) && v.issues.every(i => isRecord(i) && text(i.id) && !!i.id &&
      text(i.reason) && !!i.reason && text(i.sourceXml) &&
      (i.qualityFlag === undefined || i.qualityFlag === 'bad_location' || i.qualityFlag === 'no_time_stamp') &&
      (i.sourceCoordinate === undefined || i.qualityFlag === 'bad_location' && Array.isArray(i.sourceCoordinate) &&
        i.sourceCoordinate.length === 2 && i.sourceCoordinate.every(n => typeof n === 'number' && Number.isFinite(n)) &&
        Math.abs(i.sourceCoordinate[0]) <= 180 && Math.abs(i.sourceCoordinate[1]) <= 90) &&
      (i.report === undefined || i.qualityFlag !== 'no_time_stamp' && isUnlocatedAircraftReport(i.report) &&
        (!i.report.quality.includes('no_time_stamp') || i.report.timeSource === 'raw') && i.report.observedAt <= checkedAt + 60_000)) &&
    new Set([...v.reports, ...v.issues].map(r => r.id)).size === v.reports.length + v.issues.length;
}
