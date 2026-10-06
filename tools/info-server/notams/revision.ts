import { isDeepStrictEqual } from 'node:util';
import { isNotamRecord, type NotamRecord } from '@zlayer/contracts';
import { NotamError } from './error';
import { recordWithRevision } from './normalize';
import { fdcBodyForms } from '../../../src/layers/notams/source-text';
import { notamEndKind, notamSchedule, notamTime } from '../../../src/layers/notams/validity';
import { notamCancellationExpiresAt } from './policy';

const fraction = (value: string) => (/\.(\d+)Z$/.exec(value)?.[1] ?? '').padEnd(9, '0');
export function compareNotamRevision(next: NotamRecord, previous: NotamRecord): number {
  return next.updatedAt - previous.updatedAt || fraction(next.sourceUpdatedAt).localeCompare(fraction(previous.sourceUpdatedAt)) ||
    next.sequence - previous.sequence || next.correction - previous.correction;
}

// Compare representation separately from content; never rewrite the retained raw
// spelling. Only decimal numbers admit zero padding (not composite identifiers).
const numberContent = (value: string) => /^\d+$/.test(value) ? value.replace(/^0+(?=\d)/, '') : value;
function translationContent(text: string): string {
  // NMS also sends the ICAO formattedText as an escaped, literal <pre> wrapper.
  // Do not strip arbitrary markup, case, punctuation or non-whitespace content.
  return text.trim().replace(/^<pre>([\s\S]*)<\/pre>$/i, '$1').replace(/\s+/g, ' ').trim();
}
function translationsByType(record: NotamRecord) {
  const types = new Map<string, Set<string>>();
  for (const { type, text } of record.translations) {
    const values = types.get(type) ?? new Set<string>();
    values.add(translationContent(text)); types.set(type, values);
  }
  return types;
}
function completeLocalNotice(record: NotamRecord, text: string): boolean {
  const body = translationContent(record.text);
  if (record.classification === 'FDC') return !!fdcBodyForms(record, text)?.has(body);
  if (record.classification !== 'DOMESTIC' || record.series) return false;
  const match = /^!([A-Z0-9]{1,8}) (\d{2})\/(\d+) ([A-Z0-9]{3,5}) (.+) (\d{10})-(\d{10}(?:EST)?|PERM)$/.exec(text);
  if (!match || match[1] !== record.accountability || !record.locations.includes(match[4]!) ||
    (numberContent(record.number) !== numberContent(match[3]!) && record.number !== `${match[2]}/${match[3]}`)) return false;
  const compact = (time: number | null) => time !== null && time % 60_000 === 0
    ? new Date(time).toISOString().replace(/\D/g, '').slice(2, 12) : undefined;
  const end = match[7]!, permanent = end === 'PERM', estimated = end.endsWith('EST');
  if (compact(record.startsAt) !== match[6] ||
    (permanent ? record.endsAt !== null || record.effectiveEnd !== 'PERM' : compact(record.endsAt) !== end.replace(/EST$/, '')) ||
    record.endKind !== (permanent ? 'permanent' : estimated ? 'estimated' : 'fixed')) return false;
  const schedule = notamSchedule(record.schedule);
  return match[5] === body || !!schedule && match[5] === `${body} ${schedule}`;
}
function sharedLocalNotice(previous: NotamRecord, next: NotamRecord): boolean {
  const before = translationsByType(previous).get('LOCAL_FORMAT'), after = translationsByType(next).get('LOCAL_FORMAT');
  // One complete native notice must account for both records. Unrelated or
  // internally contradictory local translations cannot qualify this witness.
  if (before?.size !== 1 || after?.size !== 1) return false;
  const text = [...before][0]!;
  return after.has(text) && completeLocalNotice(previous, text) && completeLocalNotice(next, text);
}
const weekday = '(?:MON|TUE|WED|THU|FRI|SAT|SUN)';
const days = `(?:DLY|DAILY|${weekday}(?:-${weekday})?(?: ${weekday}(?:-${weekday})?)*)`;
const schedulePattern = new RegExp(`^(${days})(?: (\\d{4}-\\d{4}))?$`);
const scheduleSuffix = new RegExp(` (${days}) (\\d{4}-\\d{4})$`);
const additionalSchedule = new RegExp(`\\b(?:DLY|DAILY|${weekday}|\\d{4}-\\d{4})\\b`);
function scheduleParts(value: string): { days: number; hours: string | undefined } | undefined {
  const match = schedulePattern.exec(value);
  if (!match) return undefined;
  const hours = match[2];
  if (hours) {
    const [start, end] = hours.split('-');
    const clock = /^(?:[01]\d|2[0-3])[0-5]\d$/;
    if (!clock.test(start!) || !(clock.test(end!) || end === '2400') || start === end) return undefined;
  }
  let mask = 0;
  if (match[1] === 'DLY' || match[1] === 'DAILY') mask = 127;
  else for (const range of match[1]!.split(' ')) {
    const [first, last = first] = range.split('-'), names = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
    for (let day = names.indexOf(first!); ; day = (day + 1) % 7) {
      mask |= 1 << day;
      if (day === names.indexOf(last!)) break;
    }
  }
  return { days: mask, hours };
}
function equivalentSchedule(previous: NotamRecord, next: NotamRecord): string | undefined {
  const before = notamSchedule(previous.schedule), after = notamSchedule(next.schedule);
  if (before === after) return previous.schedule;
  // Optional schedule metadata can omit days/hours already supplied by the
  // identical complete native body. Every populated part must agree with that
  // body's terminal schedule; presence alone never makes a version authoritative.
  if (previous.classification !== 'DOMESTIC' || next.classification !== 'DOMESTIC' || !sharedLocalNotice(previous, next)) return undefined;
  const body = previous.text.replace(/\s+/g, ' ').trim();
  if (body !== next.text.replace(/\s+/g, ' ').trim()) return undefined;
  const suffix = scheduleSuffix.exec(body);
  if (!suffix) return undefined;
  const prefix = body.slice(0, suffix.index);
  if (additionalSchedule.test(prefix) || /\b(?:EXC|EXCEPT|NOT|BEFORE|AFTER|UNTIL|BTN|AND|OR)$/.test(prefix)) return undefined;
  const witness = scheduleParts(`${suffix[1]} ${suffix[2]}`);
  if (!witness) return undefined;
  const a = scheduleParts(before), b = scheduleParts(after);
  for (const [raw, parts] of [[before, a], [after, b]] as const) {
    if (raw && (!parts || parts.days !== witness.days || parts.hours && parts.hours !== witness.hours)) return undefined;
  }
  // Retain the fuller source spelling, not a synthesized schedule, so later
  // sparse replays cannot erase supplied hours or hide a subsequent disagreement.
  return !before || !a?.hours && b?.hours ? next.schedule : previous.schedule;
}
function compatibleIcao(a: string, b: string): boolean {
  if (a === b) return true;
  // FAA can render a domestic NOTAM under either its local number or its paired
  // international number. Only qualify NOTAMN: replacement/cancellation references
  // and unrecognized layouts must still compare exactly.
  const parse = (text: string) => /^([A-Z]\d{4}\/\d{2}|\d{2}\/\d{3}) NOTAMN Q\) (\S+) (A\) .+)$/.exec(text);
  const left = parse(a), right = parse(b);
  if (!left || !right || left[3] !== right[3]) return false;
  // A different header is allowed only across the observed domestic/international
  // formats. Two international (or two domestic) numbers are not aliases.
  if (left[1] !== right[1] && /^[A-Z]/.test(left[1]!) === /^[A-Z]/.test(right[1]!)) return false;
  const before = left[2]!.split('/'), after = right[2]!.split('/');
  // The paired rendering may omit traffic/purpose/scope. Preserve supplied values;
  // two different nonempty values, FIR/code, altitude or geometry still conflict.
  return before.length === 8 && after.length === 8 && before.every((value, i) => value === after[i] ||
    i >= 2 && i <= 4 && (!value || !after[i]));
}
function equivalentBody(previous: NotamRecord, next: NotamRecord): string | undefined {
  if (previous.text === next.text) return previous.text;
  if (previous.text.replace(/\s+/g, ' ').trim() === next.text.replace(/\s+/g, ' ').trim() &&
    sharedLocalNotice(previous, next)) return previous.text;
  const localBefore = translationsByType(previous).get('LOCAL_FORMAT'), localAfter = translationsByType(next).get('LOCAL_FORMAT');
  for (const translation of localBefore ?? []) {
    if (!localAfter?.has(translation)) continue;
    if (fdcBodyForms(previous, translation)?.has(previous.text.replace(/\s+/g, ' ').trim()) &&
      fdcBodyForms(next, translation)?.has(next.text.replace(/\s+/g, ' ').trim())) return previous.text;
  }
  const before = translationsByType(previous).get('OTHER:ICAO'), after = translationsByType(next).get('OTHER:ICAO');
  // Some source records put the entire ICAO translation into event:text. Only
  // reconcile it with an E)-only body when both records retain that exact complete
  // translation, including its header, reference, timing and any F)/G) suffix.
  for (const translation of before ?? []) {
    if (!after?.has(translation)) continue;
    if (!/^[A-Z]\d{4}\/\d{2} NOTAM[NRC](?: [A-Z]\d{4}\/\d{2})? Q\) \S+ A\) /.test(translation)) continue;
    const at = translation.indexOf(' E) '), body = at < 0 ? undefined : translation.slice(at + 4);
    if (!body) continue;
    if (translationContent(previous.text) === body && translationContent(next.text) === translation) return previous.text;
    if (translationContent(next.text) === body && translationContent(previous.text) === translation) return next.text;
  }
  return undefined;
}
function effectiveEndContent(record: NotamRecord): string {
  // EST can be encoded in effectiveEnd or in the retained source translation.
  // Only a known estimated end at the same instant admits that spelling change.
  return record.endKind === 'estimated' && record.endsAt !== null &&
    /^\d{12}(?:EST)?$/.test(record.effectiveEnd) && notamTime(record.effectiveEnd) === record.endsAt
    ? record.effectiveEnd.replace(/EST$/, '') : record.effectiveEnd;
}
// Source ID/time spellings already participate in canonical matching/ordering.
// Other operational content remains exact, including lifecycle and timing.
const contentFields = ['id', 'classification', 'number', 'series', 'year', 'locations', 'icaoLocations', 'accountability',
  'updatedAt', 'canceledAt', 'referred', 'startsAt', 'endsAt', 'endKind', 'effectiveStart', 'effectiveEnd',
  'schedule', 'changeType', 'lifecycle', 'text', 'translations', 'sequence', 'correction'] as const satisfies readonly (keyof NotamRecord)[];
export function notamContentDifferences(previous: NotamRecord, next: NotamRecord) {
  return contentFields.filter(field => {
    if (field === 'number') return numberContent(previous.number) !== numberContent(next.number);
    if (field === 'effectiveEnd') return effectiveEndContent(previous) !== effectiveEndContent(next);
    if (field === 'schedule') return equivalentSchedule(previous, next) === undefined;
    if (field === 'icaoLocations') {
      // FNSE's optional association is absent from some renderings. Absence
      // cannot withdraw a supplied association at the same source revision.
      return previous.icaoLocations.length > 0 && next.icaoLocations.length > 0 &&
        !isDeepStrictEqual([...previous.icaoLocations].sort(), [...next.icaoLocations].sort());
    }
    if (field === 'endKind' && previous.endKind !== next.endKind) {
      // This is a derivation, not an independently versioned source field.
      // A missing optional translation cannot disprove its matching EST suffix.
      if (![previous.endKind, next.endKind].every(kind => kind === 'fixed' || kind === 'estimated')) return true;
      const translations = [...previous.translations, ...next.translations];
      return notamEndKind({ ...previous, translations }) !== 'estimated' ||
        notamEndKind({ ...next, translations }) !== 'estimated';
    }
    if (field === 'text') return equivalentBody(previous, next) === undefined;
    if (field === 'referred') {
      if (!previous.referred || !next.referred) return false;
      const content = (value: NotamRecord['referred']) => value && { ...value, number: numberContent(value.number) };
      return !isDeepStrictEqual(content(previous.referred), content(next.referred));
    }
    if (field === 'translations') {
      const before = translationsByType(previous), after = translationsByType(next);
      // Missing types do not withdraw retained text. Shared types must agree,
      // including every populated qualifier in compatible ICAO renderings.
      return [...before].some(([type, values]) => {
        const incoming = after.get(type);
        if (!incoming || isDeepStrictEqual(values, incoming)) return false;
        // A qualified superset already accounts for every sparse rendering.
        // Check either order because checkpoint variants are sorted by digest.
        // An unqualified union of conflicting ICAO strings is not such evidence.
        if (type === 'OTHER:ICAO') {
          const richer = [...incoming].every(text => values.has(text)) ? previous
            : [...values].every(text => incoming.has(text)) ? next : undefined;
          const local = richer && translationsByType(richer).get('LOCAL_FORMAT');
          if (richer && local?.size === 1 && completeLocalNotice(richer, [...local][0]!)) return false;
        }
        // Captured native notices have multiple generated ICAO renderings,
        // including different Q geometry, headers and conversion artifacts.
        // A complete shared local notice plus matching core fields establishes
        // the notice; retain the auxiliary renderings without inventing equality.
        if (type === 'OTHER:ICAO' && sharedLocalNotice(previous, next)) return false;
        return type !== 'OTHER:ICAO' || [...values].some(a => [...incoming].some(b => !compatibleIcao(a, b)));
      });
    }
    return !isDeepStrictEqual(previous[field], next[field]);
  });
}

export function mergeSameNotamRevision(previous: NotamRecord, next: NotamRecord): NotamRecord {
  // A timestamped original-ID cancellation is positive source evidence. An
  // omitted optional canceled field at that same revision is not a resurrection.
  // Cancellation can occur after lastUpdated without advancing the source
  // revision. Older cancellation evidence must not withdraw that revision.
  for (const [cancelled, active] of [[previous, next], [next, previous]] as const) {
    const canceledAt = notamTime(cancelled.canceledAt);
    if (cancelled.id === active.id && cancelled.classification === active.classification &&
      numberContent(cancelled.number) === numberContent(active.number) && cancelled.series === active.series && cancelled.year === active.year &&
      cancelled.changeType === active.changeType && cancelled.lifecycle === 'cancelled' && active.lifecycle === 'active' && !active.canceledAt &&
      canceledAt !== null && (canceledAt > cancelled.updatedAt ||
        canceledAt === cancelled.updatedAt && fraction(cancelled.canceledAt) >= fraction(cancelled.sourceUpdatedAt))) return cancelled;
  }
  // These records have no active-airport membership. NMS can replace their text
  // with a terse cancellation rendering at the same source revision. Preserve
  // the retained raw record unless a later cancellation extends its retention;
  // presentation differences cannot break continuity.
  // A NOTAMC message and an original-ID tombstone remain distinct lifecycle kinds.
  if (previous.id === next.id && previous.lifecycle === next.lifecycle &&
    (previous.lifecycle === 'cancelled' || previous.lifecycle === 'cancellation')) {
    return notamCancellationExpiresAt(next)! > notamCancellationExpiresAt(previous)! ? next : previous;
  }
  const fields = notamContentDifferences(previous, next);
  if (fields.length) throw new NotamRevisionConflict(previous, next, fields);
  const types = translationsByType(previous);
  const added = next.translations.filter(t => !types.get(t.type)?.has(translationContent(t.text)));
  // Issue time is publication metadata, not the revision or effective boundary.
  // Alternate FAA renderings can report it differently. Retain the earliest
  // supplied issue time; never use this reconciliation to advance freshness.
  const issued = [previous.issuedAt, next.issuedAt].filter((time): time is number => time !== null);
  const issuedAt = issued.length ? Math.min(...issued) : null;
  const text = equivalentBody(previous, next)!, referred = previous.referred ?? next.referred;
  const schedule = equivalentSchedule(previous, next)!;
  const icaoLocations = previous.icaoLocations.length ? previous.icaoLocations : next.icaoLocations;
  const translations = added.length ? [...previous.translations, ...added] : previous.translations;
  const endKind = notamEndKind({ ...previous, translations });
  if (!added.length && issuedAt === previous.issuedAt && text === previous.text && referred === previous.referred &&
    icaoLocations === previous.icaoLocations && endKind === previous.endKind && schedule === previous.schedule) return previous;
  const { revision: _revision, ...facts } = previous;
  const merged = recordWithRevision({ ...facts, issuedAt, text, referred, icaoLocations, endKind, schedule, translations });
  if (!isNotamRecord(merged)) throw new NotamError('invalid-record');
  return merged;
}

export class NotamRevisionConflict extends NotamError {
  readonly related: NotamRevisionConflict[] = [];
  constructor(readonly previous: NotamRecord, readonly next: NotamRecord,
    readonly fields: ReturnType<typeof notamContentDifferences>) { super('revision-conflict'); }
}

export function mergeNotamRecords(previous: readonly NotamRecord[], updates: readonly NotamRecord[]): readonly NotamRecord[] {
  if (!updates.length) return previous;
  const records = new Map(previous.map(record => [record.id, record]));
  let changed = false;
  let conflict: NotamRevisionConflict | undefined;
  for (let next of updates) {
    if (next.lifecycle === 'unknown') throw new NotamError('unsupported-lifecycle');
    const old = records.get(next.id);
    if (old) {
      const order = compareNotamRevision(next, old);
      if (order < 0) continue;
      if (!order && next.revision !== old.revision) {
        try { next = mergeSameNotamRevision(old, next); }
        catch (cause) {
          if (!(cause instanceof NotamRevisionConflict)) throw cause;
          if (!conflict) conflict = cause;
          else if (conflict.related.length < 31) conflict.related.push(cause);
          continue;
        }
      }
      if (next.revision === old.revision) continue;
    }
    records.set(next.id, next); changed = true;
  }
  if (conflict) throw conflict;
  if (records.size > 150_000) throw new NotamError('record-limit');
  return changed ? [...records.values()].sort((a, b) => a.id.localeCompare(b.id)) : previous;
}
