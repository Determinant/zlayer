import type { NotamRecord } from '@zlayer/contracts';

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
/** The two supplied daily windows must agree before the machine wrapper can be
 * compared with, or interpreted as, its readable schedule. Keep source text raw. */
export function notamSchedule(schedule: string): string {
  const raw = schedule.trim().toUpperCase();
  const daily = /^DAILY:(\d{4})-(\d{4})~DLY\s+(\d{4})-(\d{4})$/.exec(raw);
  return daily && daily[1] === daily[3] && daily[2] === daily[4] ? `DLY ${daily[1]}-${daily[2]}` : raw;
}
function scheduleActive(schedule: string, now: number): boolean | undefined {
  const match = /^(DLY|DAILY|MON|TUE|WED|THU|FRI|SAT|SUN)(?:-(MON|TUE|WED|THU|FRI|SAT|SUN))?\s+(\d{4})-(\d{4})$/.exec(notamSchedule(schedule));
  if (!match) return undefined;
  const minutes = (value: string, end: boolean) => value === '2400' && end ? 1440
    : Number(value.slice(0, 2)) < 24 && Number(value.slice(2)) < 60 ? Number(value.slice(0, 2)) * 60 + Number(value.slice(2)) : NaN;
  const from = minutes(match[3]!, false), to = minutes(match[4]!, true);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return undefined;
  const weekdays = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'], date = new Date(now);
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes(), overnight = from > to;
  const day = (date.getUTCDay() + (overnight && minute < to ? 6 : 0)) % 7;
  const first = weekdays.indexOf(match[1]!), last = weekdays.indexOf(match[2] ?? match[1]!);
  if (first < 0 && match[2]) return undefined;
  const eligible = first < 0 || first <= last ? first < 0 || day >= first && day <= last : day >= first || day <= last;
  return eligible && (overnight ? minute >= from || minute < to : minute >= from && minute < to);
}
export function notamValidity(record: NotamRecord, now: number): NotamValidity {
  if (record.startsAt === null || record.endsAt !== null && record.endsAt < record.startsAt) return 'check validity';
  if (now < record.startsAt) return 'upcoming';
  const endKind = notamEndKind(record);
  if (endKind === 'unknown') return 'check validity';
  if (record.endsAt !== null && now >= record.endsAt) return endKind === 'fixed' ? 'past end' : 'check validity';
  if (record.schedule.trim()) {
    const active = scheduleActive(record.schedule, now);
    return active === undefined ? 'check schedule' : active ? 'within interval' : 'outside schedule';
  }
  return 'within interval';
}
