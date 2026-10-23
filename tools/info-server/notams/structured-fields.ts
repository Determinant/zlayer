import type { NotamRecord } from '@zlayer/contracts';
import { notamTime } from '../../../src/layers/notams/validity';

type ContentRule = 'exact' | 'number' | 'locations' | 'icao-locations' | 'start-time' | 'end-time' |
  'end-kind' | 'schedule' | 'reference' | 'body' | 'translations';
type OwnedRule = 'source-identity' | 'source-order' | 'content-hash' | 'publication-metadata' |
  'counter-evidence' | 'retained-evidence' | 'query-projection';

/** Every contract field has an owner. Adding a field must explicitly choose a
 * content rule or the stage that handles it; it cannot silently escape comparison.
 * These policies do not grant ordering or cancellation authority. */
export const notamFieldRules = {
  id: 'exact', sourceId: 'source-identity', revision: 'content-hash',
  classification: 'exact', number: 'number', series: 'exact', year: 'exact',
  locations: 'locations', icaoLocations: 'icao-locations', accountability: 'exact',
  icaoLocationVariants: 'query-projection', sourceIcaoLocations: 'retained-evidence', sourceYears: 'retained-evidence',
  issuedAt: 'publication-metadata', updatedAt: 'exact', sourceUpdatedAt: 'source-order', canceledAt: 'exact',
  referred: 'reference', startsAt: 'exact', endsAt: 'exact', endKind: 'end-kind',
  effectiveStart: 'start-time', effectiveEnd: 'end-time', schedule: 'schedule',
  changeType: 'exact', lifecycle: 'exact', text: 'body', translations: 'translations',
  sequence: 'counter-evidence', correction: 'counter-evidence', sourceCounters: 'counter-evidence',
} as const satisfies Record<keyof NotamRecord, ContentRule | OwnedRule>;

type ContentField = { [K in keyof typeof notamFieldRules]: typeof notamFieldRules[K] extends ContentRule ? K : never }[keyof typeof notamFieldRules];
const ownedRules = {
  'source-identity': true, 'source-order': true, 'content-hash': true, 'publication-metadata': true,
  'counter-evidence': true, 'retained-evidence': true, 'query-projection': true,
} satisfies Record<OwnedRule, true>;
export const notamContentFields = (Object.keys(notamFieldRules) as (keyof typeof notamFieldRules)[])
  .filter((field): field is ContentField => !Object.hasOwn(ownedRules, notamFieldRules[field]));

/** A comparison key, never a replacement source value. Date.parse alone loses
 * sub-millisecond precision. Validate through the ingestion grammar, then retain
 * all nine fractional digits so distinct instants cannot collapse to equality. */
function instant(value: string, derived: number | null, estimated: boolean): string | undefined {
  let raw = value.trim();
  if (/EST$/.test(raw)) {
    if (!estimated) return;
    raw = raw.replace(/\s*EST$/, '');
  }
  if (derived === null || notamTime(raw) !== derived) return;
  const fraction = /\.(\d{1,9})Z$/.exec(raw)?.[1] ?? '';
  return `${new Date(derived).toISOString().slice(0, 19)}.${fraction.padEnd(9, '0')}Z`;
}

export function equivalentNotamTime(previous: NotamRecord, next: NotamRecord, field: 'effectiveStart' | 'effectiveEnd'): boolean {
  if (previous[field] === next[field]) return true;
  const end = field === 'effectiveEnd', derived = end ? 'endsAt' : 'startsAt';
  const before = instant(previous[field], previous[derived], end && previous.endKind === 'estimated');
  const after = instant(next[field], next[derived], end && next.endKind === 'estimated');
  return before !== undefined && before === after;
}
