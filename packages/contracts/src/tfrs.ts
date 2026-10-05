import { isRecord } from './validation.js';

export const TFR_REFRESH_MS = 180_000;
export const TFR_STALE_MS = 2 * TFR_REFRESH_MS;
/** Index checks cannot renew the age of independently downloaded XML detail. */
export const TFR_DETAIL_REFRESH_MS = 15 * 60_000;
export const TFR_MAX_BYTES = 8 * 1024 * 1024;
export const TFR_MAX_NOTICES = 1000;
export type TfrWindow = { startsAt: number; endsAt: number | null;
  daily?: { startSeconds: number; endSeconds: number; days: number[] } };
export type TfrArea = { id: string; name: string; lower: string; upper: string;
  /** Great-circle edges are densified. Longitudes unwrap within one <180° local interval. */
  geometry: { type: 'Polygon'; coordinates: [number, number][][] } | null;
  /** Null means the published schedule could not be interpreted. */
  windows: TfrWindow[] | null };
export type TfrIndexEntry = { id: string; modifiedAt: number; title: string; type: string; facility: string; state: string };
export type TfrSourceIssue = TfrIndexEntry & { reason: 'detail-unavailable' | 'detail-invalid'; retainedCheckedAt: number | null };
export type TfrNotice = TfrIndexEntry & {
  /** Detail acquisition start. Absent in legacy snapshots; never infer it from the index. */
  detailCheckedAt?: number;
  startsAt: number; endsAt: number | null; text: string; areas: TfrArea[] };
export type TfrSnapshot = { schemaVersion: 1; source: 'FAA-TFR'; checkedAt: number; notices: TfrNotice[]; error?: string;
  /** Every failed index member remains explicit. Older detail may be retained at its original check time. */
  issues?: TfrSourceIssue[] };
const time = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v < 8.64e15;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const span = (v: Record<string, unknown>) => time(v.startsAt) && (v.endsAt === null || time(v.endsAt) && v.endsAt > v.startsAt);
function window(v: unknown): v is TfrWindow {
  if (!isRecord(v) || !span(v)) return false;
  if (v.daily === undefined) return true;
  const d = v.daily;
  return isRecord(d) && [d.startSeconds, d.endSeconds].every(n => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 86400) &&
    Array.isArray(d.days) && d.days.length > 0 && d.days.length <= 7 && new Set(d.days).size === d.days.length &&
    d.days.every(n => Number.isInteger(n) && n >= 0 && n <= 6);
}
function area(v: unknown): v is TfrArea {
  if (!isRecord(v) || !text(v.id, 128) || !text(v.name, 256) || !text(v.lower, 128) || !text(v.upper, 128) ||
    !(v.windows === null || Array.isArray(v.windows) && v.windows.length > 0 && v.windows.length <= 128 && v.windows.every(window))) return false;
  if (v.geometry === null) return true;
  const g = v.geometry;
  return isRecord(g) && g.type === 'Polygon' && Array.isArray(g.coordinates) && g.coordinates.length > 0 && g.coordinates.length <= 16 &&
    g.coordinates.every(r => Array.isArray(r) && r.length >= 4 && r.length <= 8192 && r.every(p => Array.isArray(p) && p.length === 2 &&
      p.every(n => typeof n === 'number' && Number.isFinite(n)) && Math.abs(p[0]) <= 540 && Math.abs(p[1]) <= 85) &&
      Math.abs(r[0][0]) <= 180 && Math.max(...r.map(p => p[0])) - Math.min(...r.map(p => p[0])) < 180 &&
      r[0][0] === r.at(-1)[0] && r[0][1] === r.at(-1)[1]);
}
export function isTfrIndexEntry(v: unknown): v is TfrIndexEntry & Record<string, unknown> {
  return isRecord(v) && typeof v.id === 'string' && /^\d\/\d{4}$/.test(v.id) && time(v.modifiedAt) &&
    text(v.title, 2048) && text(v.type, 128) && text(v.facility, 32) && text(v.state, 64);
}
export function isTfrNotice(v: unknown): v is TfrNotice {
  return isTfrIndexEntry(v) && (v.detailCheckedAt === undefined || time(v.detailCheckedAt)) && span(v) && text(v.text, 256 * 1024) &&
    Array.isArray(v.areas) && v.areas.length <= 128 && v.areas.every(area) && new Set(v.areas.map(a => a.id)).size === v.areas.length &&
    v.areas.every(a => a.windows === null || a.windows.every((w: TfrWindow) => w.startsAt >= (v.startsAt as number) &&
      (v.endsAt === null || w.endsAt !== null && w.endsAt <= (v.endsAt as number))));
}
export function isTfrSnapshot(v: unknown): v is TfrSnapshot {
  if (!isRecord(v) || v.schemaVersion !== 1 || v.source !== 'FAA-TFR' || !time(v.checkedAt) ||
    !(v.error === undefined || text(v.error, 128)) ||
    !Array.isArray(v.notices) || v.notices.length > TFR_MAX_NOTICES || !v.notices.every(isTfrNotice) ||
    new Set(v.notices.map(n => n.id)).size !== v.notices.length) return false;
  if (v.issues === undefined) return true; // Legacy complete snapshots remain readable.
  if (!Array.isArray(v.issues) || v.issues.length > TFR_MAX_NOTICES || v.issues.length && !v.error) return false;
  const notices = new Map(v.notices.map(n => [n.id, n]));
  const ids = new Set<string>();
  for (const issue of v.issues) {
    if (!isTfrIndexEntry(issue) || ids.has(issue.id) ||
      issue.reason !== 'detail-unavailable' && issue.reason !== 'detail-invalid') return false;
    ids.add(issue.id);
    const retained = notices.get(issue.id);
    if (retained) {
      if (issue.retainedCheckedAt !== null && (!time(issue.retainedCheckedAt) || issue.retainedCheckedAt > v.checkedAt) ||
        retained.detailCheckedAt !== undefined && issue.retainedCheckedAt !== retained.detailCheckedAt) return false;
    } else if (issue.retainedCheckedAt !== null) return false;
  }
  return new Set([...notices.keys(), ...ids]).size <= TFR_MAX_NOTICES;
}
