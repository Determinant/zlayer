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
// Source ID/time spellings already participate in canonical matching/ordering.
// Other operational fields remain exact, including body, lifecycle and timing.
const contentFields = ['id', 'classification', 'number', 'series', 'year', 'locations', 'icaoLocations', 'accountability',
  'issuedAt', 'updatedAt', 'canceledAt', 'referred', 'startsAt', 'endsAt', 'endKind', 'effectiveStart', 'effectiveEnd',
  'schedule', 'changeType', 'lifecycle', 'text', 'translations', 'sequence', 'correction'] as const satisfies readonly (keyof NotamRecord)[];
export function notamContentDifferences(previous: NotamRecord, next: NotamRecord) {
  return contentFields.filter(field => {
    if (field === 'number') return numberContent(previous.number) !== numberContent(next.number);
    if (field === 'referred') {
      const content = (value: NotamRecord['referred']) => value && { ...value, number: numberContent(value.number) };
      return !isDeepStrictEqual(content(previous.referred), content(next.referred));
    }
    if (field === 'translations') {
      const before = translationsByType(previous), after = translationsByType(next);
      // Translation availability is optional. Shared types must agree completely;
      // a missing type is not a withdrawal or permission to discard retained text.
      return [...before].some(([type, values]) => after.has(type) && !isDeepStrictEqual(values, after.get(type)));
    }
    return !isDeepStrictEqual(previous[field], next[field]);
  });
}

export function mergeSameNotamRevision(previous: NotamRecord, next: NotamRecord): NotamRecord {
  const fields = notamContentDifferences(previous, next);
  if (fields.length) throw new NotamRevisionConflict(previous, next, fields);
  const types = new Set(previous.translations.map(t => t.type));
  const added = next.translations.filter(t => !types.has(t.type));
  if (!added.length) return previous;
  const { revision: _revision, ...facts } = previous;
  const merged = recordWithRevision({ ...facts, translations: [...previous.translations, ...added] });
  if (!isNotamRecord(merged)) throw new NotamError('invalid-record');
  return merged;
}

export class NotamRevisionConflict extends NotamError {
  constructor(readonly previous: NotamRecord, readonly next: NotamRecord,
    readonly fields: ReturnType<typeof notamContentDifferences>) { super('revision-conflict'); }
}
