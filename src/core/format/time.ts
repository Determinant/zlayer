type TimeValue = string | number | null | undefined;
type TimeOptions = { now?: number; timeZone?: string };
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const minute = 60_000, hour = 60 * minute, day = 24 * hour;
const unknown = '—';

function readDate(value: TimeValue): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string' &&
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  // Calendar dates describe editions, independent of the device's time zone.
  if (typeof value === 'string' &&
    new Date(value.slice(0, 10)).toISOString().slice(0, 10) !== value.slice(0, 10)) return undefined;
  return date;
}

function calendar(date: Date, withYear: boolean): string {
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}${withYear ? `, ${date.getUTCFullYear()}` : ''}`;
}

/** UI dates use English month names; older/future years remain explicit. */
export function formatDate(value: TimeValue, now = Date.now()): string {
  const date = readDate(value);
  return date ? calendar(date, date.getUTCFullYear() !== new Date(now).getUTCFullYear()) : unknown;
}

export function formatDateRange(from: TimeValue, to: TimeValue, now = Date.now()): string {
  const start = readDate(from), end = readDate(to);
  if (!start || !end || end < start) return unknown;
  if (start.getUTCFullYear() !== end.getUTCFullYear()) return `${calendar(start, true)}–${calendar(end, true)}`;
  if (start.getUTCMonth() === end.getUTCMonth() && start.getUTCDate() === end.getUTCDate()) return formatDate(from, now);
  const endMonth = start.getUTCMonth() === end.getUTCMonth() ? '' : `${months[end.getUTCMonth()]} `;
  const year = end.getUTCFullYear() !== new Date(now).getUTCFullYear() ? `, ${end.getUTCFullYear()}` : '';
  return `${calendar(start, false)}–${endMonth}${end.getUTCDate()}${year}`;
}

const clocks = new Map<string, Intl.DateTimeFormat>();
function clock(timeZone: string): Intl.DateTimeFormat {
  if (timeZone === 'local') timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  let formatter = clocks.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      hourCycle: 'h23', timeZoneName: 'short', timeZone,
    });
    clocks.set(timeZone, formatter);
  }
  return formatter;
}

function timestampParts(value: TimeValue, { now = Date.now(), timeZone = 'UTC' }: TimeOptions) {
  const date = readDate(value);
  if (!date) return undefined;
  const formatter = clock(timeZone);
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  const currentYear = formatter.formatToParts(now).find(part => part.type === 'year')?.value;
  return { date: `${parts.month} ${parts.day}${parts.year !== currentYear ? `, ${parts.year}` : ''}`,
    time: `${parts.hour}:${parts.minute}`, zone: timeZone === 'UTC' ? 'Z' : ` ${parts.timeZoneName}` };
}

/** UTC by default; pass timeZone: 'local' for explicitly labeled device time. */
export function formatTimestamp(value: TimeValue, options: TimeOptions = {}): string {
  const parts = timestampParts(value, options);
  return parts ? `${parts.date} · ${parts.time}${parts.zone}` : unknown;
}

export function formatTimestampRange(from: TimeValue, to: TimeValue, options: TimeOptions = {}): string {
  const start = timestampParts(from, options), end = timestampParts(to, options);
  if (!start || !end || readDate(to)! < readDate(from)!) return unknown;
  if (start.date === end.date && start.zone === end.zone) {
    return `${start.date} · ${start.time}–${end.time}${end.zone}`;
  }
  return `${formatTimestamp(from, options)} – ${formatTimestamp(to, options)}`;
}

/** Completed units only: an observation must never appear older by rounding up. */
export function formatAge(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return unknown;
  if (milliseconds < minute) return '<1m';
  if (milliseconds < hour) return `${Math.floor(milliseconds / minute)}m`;
  if (milliseconds < day) {
    const remainder = Math.floor(milliseconds % hour / minute);
    return `${Math.floor(milliseconds / hour)}h${remainder ? ` ${remainder}m` : ''}`;
  }
  return `${Math.floor(milliseconds / day)}d`;
}

export function formatDataAge(value: TimeValue, now = Date.now()): string {
  const date = readDate(value);
  if (!date || !Number.isFinite(now)) return 'Age unknown';
  if (date.getTime() > now) return 'Future timestamp';
  return `${formatAge(now - date.getTime())} old`;
}

export function formatCheckedAt(value: TimeValue, now = Date.now()): string {
  const date = readDate(value);
  if (!date || !Number.isFinite(now)) return 'Check time unknown';
  const age = now - date.getTime();
  if (age < 0) return 'Future check time';
  return age < minute ? 'Checked now' : `Checked ${formatAge(age)} ago`;
}
