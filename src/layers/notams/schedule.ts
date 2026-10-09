/** Schedule meaning is shared by collection reconciliation and client validity.
 * Missing hours are evidence of days only, never an all-day window. Raw source
 * fields stay on the record; this projection is neither stored nor displayed. */
export type WeeklyNotamSchedule = {
  kind: 'weekly'; days: number; window: { start: number; end: number } | null;
};
export type NotamSchedule = WeeklyNotamSchedule | { kind: 'empty' } | { kind: 'opaque'; text: string };

const weekdays = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const weekdayNames = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const day = '(?:SUN|MON|TUE|WED|THU|FRI|SAT)';
const days = `(?:DLY|DAILY|${day}(?:-${day})?(?: ${day}(?:-${day})?)*)`;
const readablePattern = new RegExp(`^(${days})(?: (\\d{4})-(\\d{4}))?$`);
const bodySuffix = new RegExp(` (${days}) (\\d{4})-(\\d{4})$`);
const earlierSchedule = new RegExp(`\\b(?:DLY|DAILY|${day}|\\d{4}-\\d{4})\\b`);

function minute(value: string, end: boolean): number | undefined {
  if (end && value === '2400') return 1440;
  if (!/^(?:[01]\d|2[0-3])[0-5]\d$/.test(value)) return undefined;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(2));
}

function readable(text: string): WeeklyNotamSchedule | undefined {
  const match = readablePattern.exec(text.replace(/\s+/g, ' '));
  if (!match) return undefined;
  let mask = 0;
  if (match[1] === 'DLY' || match[1] === 'DAILY') mask = 127;
  else for (const range of match[1]!.split(' ')) {
    const [first, last = first] = range.split('-');
    for (let index = weekdays.indexOf(first!); ; index = (index + 1) % 7) {
      mask |= 1 << index;
      if (index === weekdays.indexOf(last!)) break;
    }
  }
  if (match[2] === undefined) return { kind: 'weekly', days: mask, window: null };
  const start = minute(match[2], false), end = minute(match[3]!, true);
  if (start === undefined || end === undefined || start === end) return undefined;
  return { kind: 'weekly', days: mask, window: { start, end } };
}

export function equalNotamSchedules(a: NotamSchedule, b: NotamSchedule): boolean {
  if (a.kind === 'empty') return b.kind === 'empty';
  if (a.kind === 'opaque') return b.kind === 'opaque' && a.text === b.text;
  return b.kind === 'weekly' && a.days === b.days &&
    a.window?.start === b.window?.start && a.window?.end === b.window?.end;
}

/** Decode each representation before comparing it. A machine/readable wrapper
 * supplies two assertions: neither side wins if their days or windows disagree.
 * Unknown syntax remains opaque, including solar times and multiple windows. */
export function parseNotamSchedule(value: string): NotamSchedule {
  const text = value.trim().toUpperCase();
  if (!text) return { kind: 'empty' };
  const opaque: NotamSchedule = { kind: 'opaque', text };
  if (!text.includes('~')) return readable(text) ?? opaque;
  const wrapper = /^([A-Z]+):(\d{4})-(\d{4})~([^~]+)$/.exec(text);
  if (!wrapper) return opaque;
  const index = weekdayNames.indexOf(wrapper[1]!);
  const name = wrapper[1] === 'DAILY' ? 'DLY' : weekdays[index];
  if (!name) return opaque;
  const machine = readable(`${name} ${wrapper[2]}-${wrapper[3]}`), supplied = readable(wrapper[4]!.trim());
  return machine && supplied && equalNotamSchedules(machine, supplied) ? machine : opaque;
}

/** Evidence for omitted metadata must be one unqualified terminal schedule in
 * an independently authenticated native body. This extracts no source fields. */
export function notamBodySchedule(body: string): WeeklyNotamSchedule | undefined {
  const suffix = bodySuffix.exec(body);
  if (!suffix) return undefined;
  const prefix = body.slice(0, suffix.index);
  if (earlierSchedule.test(prefix) || /\b(?:EXC|EXCEPT|NOT|BEFORE|AFTER|UNTIL|BTN|AND|OR)$/.test(prefix)) return undefined;
  return readable(suffix[0].trim());
}

/** Partial assertions can be supplemented only by a complete matching witness.
 * An opaque expression never becomes absence and cannot discard qualifications. */
export function notamScheduleFits(schedule: NotamSchedule, witness: WeeklyNotamSchedule): boolean {
  return witness.window !== null && (schedule.kind === 'empty' || schedule.kind === 'weekly' &&
    schedule.days === witness.days && (schedule.window === null || equalNotamSchedules(schedule, witness)));
}

export function notamScheduleActive(schedule: NotamSchedule, now: number): boolean | undefined {
  if (schedule.kind !== 'weekly' || !schedule.window || !Number.isFinite(now)) return undefined;
  const { start, end } = schedule.window, date = new Date(now);
  const time = date.getUTCHours() * 60 + date.getUTCMinutes(), overnight = start > end;
  // After midnight, an overnight window still belongs to its starting weekday.
  const day = (date.getUTCDay() + (overnight && time < end ? 6 : 0)) % 7;
  return !!(schedule.days & (1 << day)) && (overnight ? time >= start || time < end : time >= start && time < end);
}
