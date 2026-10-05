import { isDeepStrictEqual } from 'node:util';
import type { NotamRecord } from '@zlayer/contracts';
import { NotamError } from './error';

const fraction = (value: string) => (/\.(\d+)Z$/.exec(value)?.[1] ?? '').padEnd(9, '0');
export function compareNotamRevision(next: NotamRecord, previous: NotamRecord): number {
  return next.updatedAt - previous.updatedAt || fraction(next.sourceUpdatedAt).localeCompare(fraction(previous.sourceUpdatedAt)) ||
    next.sequence - previous.sequence || next.correction - previous.correction;
}

// Source IDs and update-time spellings are preserved in the raw digest, but their
// canonical identity/time already participate in matching and revision ordering.
// Every operational field remains exact, including text, translations and timing.
const contentFields = ['id', 'classification', 'number', 'series', 'year', 'locations', 'icaoLocations', 'accountability',
  'issuedAt', 'updatedAt', 'canceledAt', 'referred', 'startsAt', 'endsAt', 'endKind', 'effectiveStart', 'effectiveEnd',
  'schedule', 'changeType', 'lifecycle', 'text', 'translations', 'sequence', 'correction'] as const satisfies readonly (keyof NotamRecord)[];
export function notamContentDifferences(previous: NotamRecord, next: NotamRecord) {
  return contentFields.filter(field => !isDeepStrictEqual(previous[field], next[field]));
}

export class NotamRevisionConflict extends NotamError {
  constructor(readonly previous: NotamRecord, readonly next: NotamRecord,
    readonly fields: ReturnType<typeof notamContentDifferences>) { super('revision-conflict'); }
}
