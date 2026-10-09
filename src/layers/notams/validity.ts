import type { NotamRecord } from '@zlayer/contracts';
import { notamScheduleActive, parseNotamSchedule } from './schedule';

/** Unknown dates stay unknown; never let Date silently roll an invalid UTC day forward. */
export function notamTime(value: string): number | null {
  const clean = value.trim().replace(/\s*EST$/, '');
  const compact = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?$/.exec(clean);
  const iso = compact ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6] ?? '00'}Z` : clean;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(iso)) return null;
  const time = Date.parse(iso);
  return Number.isFinite(time) && time >= 0 && new Date(time).toISOString().slice(0, 19) === iso.slice(0, 19) ? time : null;
}
type EndEvidence = Pick<NotamRecord, 'effectiveEnd' | 'endKind' | 'text' | 'translations'>;
const endKinds = new WeakMap<EndEvidence, NotamRecord['endKind']>();

/** Read all source representations, including validity followed by multipart footers.
 * An EST token must identify the structured end; conflicting evidence stays unknown. */
export function notamEndKind(record: EndEvidence): NotamRecord['endKind'] {
  const cached = endKinds.get(record);
  if (cached) return cached;
  const end = notamTime(record.effectiveEnd);
  const compactEnd = end === null ? undefined : new Date(end).toISOString().replace(/\D/g, '').slice(2, 12);
  let estimated = record.endKind === 'estimated' || /EST$/.test(record.effectiveEnd.trim()), conflicting = false;
  for (const text of [record.text, ...record.translations.map(t => t.text)]) {
    for (const match of text.matchAll(/\b\d{10}-(\d{10})EST\b/g)) {
      if (match[1] === compactEnd) estimated = true;
      else conflicting = true;
    }
  }
  const kind = conflicting ? 'unknown' : record.effectiveEnd.trim() === 'PERM' ? 'permanent'
    : end === null ? 'unknown' : estimated ? 'estimated' : 'fixed';
  endKinds.set(record, kind);
  return kind;
}

export type NotamValidity = 'upcoming' | 'within interval' | 'outside schedule' | 'past end' | 'check schedule' | 'check validity';
export function notamValidity(record: NotamRecord, now: number): NotamValidity {
  if (record.startsAt === null || record.endsAt !== null && record.endsAt < record.startsAt) return 'check validity';
  if (now < record.startsAt) return 'upcoming';
  const endKind = notamEndKind(record);
  if (endKind === 'unknown') return 'check validity';
  if (record.endsAt !== null && now >= record.endsAt) return endKind === 'fixed' ? 'past end' : 'check validity';
  if (record.schedule.trim()) {
    const active = notamScheduleActive(parseNotamSchedule(record.schedule), now);
    return active === undefined ? 'check schedule' : active ? 'within interval' : 'outside schedule';
  }
  return 'within interval';
}
