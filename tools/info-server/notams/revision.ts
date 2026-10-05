import { isDeepStrictEqual } from 'node:util';
import { isNotamRecord, type NotamRecord } from '@zlayer/contracts';
import { NotamError } from './error';
import { recordWithRevision } from './normalize';

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
  const parse = (text: string) => /^(?:[A-Z]\d{4}\/\d{2}|\d{2}\/\d{3}) NOTAMN Q\) (\S+) (A\) .+)$/.exec(text);
  const left = parse(a), right = parse(b);
  if (!left || !right || left[2] !== right[2]) return false;
  const before = left[1]!.split('/'), after = right[1]!.split('/');
  // The paired rendering may omit traffic/purpose/scope. Preserve supplied values;
  // two different nonempty values, FIR/code, altitude or geometry still conflict.
  return before.length === 8 && after.length === 8 && before.every((value, i) => value === after[i] ||
    i >= 2 && i <= 4 && (!value || !after[i]));
}
function equivalentBody(previous: NotamRecord, next: NotamRecord): string | undefined {
  if (previous.text === next.text) return previous.text;
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
// Source ID/time spellings already participate in canonical matching/ordering.
// Other operational content remains exact, including lifecycle and timing.
const contentFields = ['id', 'classification', 'number', 'series', 'year', 'locations', 'icaoLocations', 'accountability',
  'updatedAt', 'canceledAt', 'referred', 'startsAt', 'endsAt', 'endKind', 'effectiveStart', 'effectiveEnd',
  'schedule', 'changeType', 'lifecycle', 'text', 'translations', 'sequence', 'correction'] as const satisfies readonly (keyof NotamRecord)[];
export function notamContentDifferences(previous: NotamRecord, next: NotamRecord) {
  return contentFields.filter(field => {
    if (field === 'number') return numberContent(previous.number) !== numberContent(next.number);
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
