import { isDeepStrictEqual } from 'node:util';
import { isNotamRecord, type NotamRecord } from '@zlayer/contracts';
import { NotamError } from './error';
import { recordWithRevision } from './normalize';
import { notamTime } from '../../../src/layers/notams/validity';

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
function fdcBodyForms(record: NotamRecord, translation: string): Set<string> | undefined {
  // Prove each optional body wrapper against the complete shared LOCAL_FORMAT,
  // including its source identity and actual interval. A substring match or an
  // unrelated ICAO rendering (which may carry old dates) is not sufficient.
  const match = /^!FDC (\d)\/(\d{4}) ([A-Z0-9]{3,5}) (IAP|SID|STAR|ODP) (.+) (\d{10})-(\d{10})(EST)?$/.exec(translation);
  if (!match || record.classification !== 'FDC' || record.series || !/^\d{4}$/.test(record.year) ||
    !record.year.endsWith(match[1]!) || numberContent(record.number) !== numberContent(match[2]!) ||
    !record.locations.includes(match[3]!)) return;
  const compact = (time: number | null) => time !== null && time % 60_000 === 0
    ? new Date(time).toISOString().replace(/\D/g, '').slice(2, 12) : undefined;
  if (compact(record.startsAt) !== match[6] || compact(record.endsAt) !== match[7] ||
    record.endKind !== (match[8] ? 'estimated' : 'fixed')) return;
  const subject = match[4]!, body = match[5]!, interval = `${match[6]}-${match[7]}${match[8] ?? ''}`;
  return new Set([body, `${subject} ${body}`, `${body} ${interval}`, `${subject} ${body} ${interval}`]);
}
function equivalentBody(previous: NotamRecord, next: NotamRecord): string | undefined {
  if (previous.text === next.text) return previous.text;
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
        return type !== 'OTHER:ICAO' || [...values].some(a => [...incoming].some(b => !compatibleIcao(a, b)));
      });
    }
    return !isDeepStrictEqual(previous[field], next[field]);
  });
}

export function mergeSameNotamRevision(previous: NotamRecord, next: NotamRecord): NotamRecord {
  // These records have no active-airport membership. NMS can replace their text
  // with a terse cancellation rendering at the same source revision. Preserve
  // the retained raw record; presentation differences cannot break continuity.
  // A NOTAMC message and an original-ID tombstone remain distinct lifecycle kinds.
  if (previous.id === next.id && previous.lifecycle === next.lifecycle &&
    (previous.lifecycle === 'cancelled' || previous.lifecycle === 'cancellation')) return previous;
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
  if (!added.length && issuedAt === previous.issuedAt && text === previous.text && referred === previous.referred) return previous;
  const { revision: _revision, ...facts } = previous;
  const merged = recordWithRevision({ ...facts, issuedAt, text, referred, translations: [...previous.translations, ...added] });
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
