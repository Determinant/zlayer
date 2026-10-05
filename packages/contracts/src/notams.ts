import { isRecord, isSha256 } from './validation.js';

export const NOTAM_REFRESH_MS = 180_000;
export const NOTAM_STALE_MS = 2 * NOTAM_REFRESH_MS;
export const NOTAM_AIRPORT_MAX_RECORDS = 5000;
export const NOTAM_AIRPORT_MAX_BYTES = 16 * 1024 * 1024;
export type NotamEnvironment = 'staging' | 'production';
export type NotamAirportQuery = { faaId?: string; icaoId?: string };
export type NotamRecord = {
  id: string; sourceId: string; revision: string;
  classification: string; number: string; series: string; year: string;
  locations: string[]; icaoLocations: string[]; accountability: string;
  issuedAt: number | null; updatedAt: number;
  sourceUpdatedAt: string; canceledAt: string;
  referred: { series: string; number: string; year: string } | null;
  startsAt: number | null; endsAt: number | null;
  endKind: 'fixed' | 'estimated' | 'permanent' | 'unknown';
  effectiveStart: string; effectiveEnd: string; schedule: string;
  changeType: string; lifecycle: 'active' | 'cancelled' | 'cancellation' | 'unknown';
  text: string; translations: { type: string; text: string }[];
  sequence: number; correction: number;
};
export type NotamFeedStatus = {
  enabled: boolean; environment: NotamEnvironment | null;
  state: 'disabled' | 'loading' | 'ready' | 'degraded' | 'unavailable';
  generation: string | null; checkedAt: number | null; watermark: number | null;
  fullSyncAt: number | null; recordCount: number;
  continuity: 'complete' | 'incomplete'; error: string | null; nextAttemptAt: number | null;
};
export type NotamAirportSnapshot = {
  schemaVersion: 1; query: NotamAirportQuery; feed: NotamFeedStatus;
  scope: 'airport-location'; associationCoverage: 'complete' | 'incomplete';
  records: NotamRecord[];
};

const text = (v: unknown, max = 256 * 1024): v is string => typeof v === 'string' && v.length <= max;
const time = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v < 8.64e15;
const optionalTime = (v: unknown): v is number | null => v === null || time(v);
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const codes = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 32 &&
  v.every(s => typeof s === 'string' && /^[A-Z0-9]{2,8}$/.test(s)) && new Set(v).size === v.length;
export function isNotamAirportQuery(v: unknown): v is NotamAirportQuery {
  return isRecord(v) && Object.keys(v).every(k => k === 'faaId' || k === 'icaoId') &&
    (v.faaId !== undefined || v.icaoId !== undefined) &&
    (v.faaId === undefined || typeof v.faaId === 'string' && /^[A-Z0-9]{3,5}$/.test(v.faaId)) &&
    (v.icaoId === undefined || typeof v.icaoId === 'string' && /^[A-Z]{4}$/.test(v.icaoId));
}
export function notamAirportKey(query: NotamAirportQuery): string {
  return `faa:${query.faaId ?? ''}|icao:${query.icaoId ?? ''}`;
}
export function isNotamRecord(v: unknown): v is NotamRecord {
  return isRecord(v) && typeof v.id === 'string' && /^\d{16}$/.test(v.id) &&
    (v.sourceId === v.id || v.sourceId === `NMS_ID_${v.id}`) && isSha256(v.revision) &&
    text(v.classification, 64) && text(v.number, 64) && text(v.series, 16) && text(v.year, 8) &&
    codes(v.locations) && codes(v.icaoLocations) && text(v.accountability, 32) &&
    optionalTime(v.issuedAt) && time(v.updatedAt) && optionalTime(v.startsAt) && optionalTime(v.endsAt) &&
    text(v.sourceUpdatedAt, 64) && text(v.canceledAt, 64) &&
    (v.referred === null || isRecord(v.referred) && text(v.referred.series, 16) && text(v.referred.number, 64) && text(v.referred.year, 8)) &&
    ['fixed', 'estimated', 'permanent', 'unknown'].includes(String(v.endKind)) &&
    text(v.effectiveStart, 128) && text(v.effectiveEnd, 128) && text(v.schedule, 4096) &&
    text(v.changeType, 32) && ['active', 'cancelled', 'cancellation', 'unknown'].includes(String(v.lifecycle)) &&
    text(v.text) && Array.isArray(v.translations) && v.translations.length <= 8 &&
    v.translations.every(t => isRecord(t) && text(t.type, 64) && text(t.text)) &&
    integer(v.sequence) && integer(v.correction);
}
export function isNotamFeedStatus(v: unknown): v is NotamFeedStatus {
  return isRecord(v) && typeof v.enabled === 'boolean' &&
    (v.environment === null || v.environment === 'staging' || v.environment === 'production') &&
    ['disabled', 'loading', 'ready', 'degraded', 'unavailable'].includes(String(v.state)) &&
    (v.generation === null || isSha256(v.generation)) && optionalTime(v.checkedAt) &&
    optionalTime(v.watermark) && optionalTime(v.fullSyncAt) && integer(v.recordCount) &&
    (v.continuity === 'complete' || v.continuity === 'incomplete') &&
    (v.error === null || typeof v.error === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(v.error)) && optionalTime(v.nextAttemptAt);
}
export function isNotamAirportSnapshot(v: unknown): v is NotamAirportSnapshot {
  return isRecord(v) && v.schemaVersion === 1 && isNotamAirportQuery(v.query) &&
    isNotamFeedStatus(v.feed) && v.feed.generation !== null && v.feed.environment !== null &&
    v.scope === 'airport-location' && ['complete', 'incomplete'].includes(String(v.associationCoverage)) &&
    Array.isArray(v.records) && v.records.length <= NOTAM_AIRPORT_MAX_RECORDS && v.records.every(isNotamRecord) &&
    new Set(v.records.map(r => r.id)).size === v.records.length;
}
