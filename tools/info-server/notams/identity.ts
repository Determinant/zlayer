import type { NotamRecord } from '@zlayer/contracts';
import { localKey, icaoEvidence, bindsIcaoIdentityAndInterval } from '../../../src/layers/notams/notice-evidence';
import { equalNotamSchedules, notamScheduleFits, parseNotamSchedule } from '../../../src/layers/notams/schedule';
import { notamTime } from '../../../src/layers/notams/validity';
import { notamCancellationIdentity } from './cancellation-identity';

const notamTimeFraction = (value: string) => (/\.(\d+)Z$/.exec(value)?.[1] ?? '').padEnd(9, '0');
export const notamNumberContent = (value: string) => /^\d+$/.test(value) ? value.replace(/^0+(?=\d)/, '') : value;

/** NMS source time orders revisions; AIXM counters and retrieval order do not. */
export function compareNotamRevision(next: Pick<NotamRecord, 'updatedAt' | 'sourceUpdatedAt'>,
  previous: Pick<NotamRecord, 'updatedAt' | 'sourceUpdatedAt'>): number {
  return next.updatedAt - previous.updatedAt || notamTimeFraction(next.sourceUpdatedAt).localeCompare(notamTimeFraction(previous.sourceUpdatedAt));
}

/** A source-ID cancellation is an independent event, sometimes later than the
 * unchanged source revision. This predicate grants no cross-identity authority. */
export function hasPositiveNotamCancellation(record: NotamRecord): boolean {
  const canceledAt = notamTime(record.canceledAt);
  return record.lifecycle === 'cancelled' && canceledAt !== null && (canceledAt > record.updatedAt ||
    canceledAt === record.updatedAt && notamTimeFraction(record.canceledAt) >= notamTimeFraction(record.sourceUpdatedAt));
}

const identityFields = ['id', 'classification', 'number', 'series', 'year', 'changeType'] as const;
function identityDifferences(previous: NotamRecord, next: NotamRecord) {
  return identityFields.filter(field => field === 'number'
    ? notamNumberContent(previous.number) !== notamNumberContent(next.number) : previous[field] !== next[field]);
}

/** Comparison views only. A year must come from this exact source revision,
 * with a complete notice witness or explicit source-ID cancellation event.
 * Effective dates never supply the NOTAM numbering year. */
function supplementNotamYear(previous: NotamRecord, next: NotamRecord): [NotamRecord, NotamRecord] | undefined {
  if (previous.year === next.year || compareNotamRevision(previous, next) !== 0 ||
    identityDifferences(previous, next).some(field => field !== 'year')) return;
  const years = [...new Set([previous.year, next.year])];
  if (years.length !== 2 || !years.includes('')) return;
  const year = years.find(Boolean)!;
  if (!/^\d{4}$/.test(year)) return;
  const before = previous.year ? previous : { ...previous, year };
  const after = next.year ? next : { ...next, year };
  // A retained proof binds the year to this exact ID/revision/notice identity.
  // Content and lifecycle still undergo their own checks. Requiring a particular
  // body here would lose the identity when a cancellation becomes terse.
  const retained = [previous, next].some(record => record.sourceYears?.includes('') && record.sourceYears.includes(year));
  const icaoWitness = (record: NotamRecord) => {
    const evidence = icaoEvidence(record, 'aixm');
    return !!evidence?.notices.length && evidence.notices.every(notice => {
      const supplied = parseNotamSchedule(record.schedule), witness = parseNotamSchedule(notice.schedule);
      return bindsIcaoIdentityAndInterval(record, notice) && (equalNotamSchedules(supplied, witness) ||
        witness.kind === 'weekly' && notamScheduleFits(supplied, witness));
    });
  };
  // A complete notice or qualified cancellation binds this ID/revision even
  // when the other rendering is sparse. Missing schedule metadata can fit its
  // notice witness; all supplied schedules and other operational differences
  // still undergo content/lifecycle checks. No witness selects between two years.
  if (!retained && ![before, after].some(record =>
    hasPositiveNotamCancellation(record) || notamCancellationIdentity(record).witness || localKey(record) !== undefined || icaoWitness(record))) return;
  return [before, after];
}

/** Identity evidence precedes both lifecycle and content decisions. A witnessed
 * omission has the same meaning before and after original-ID cancellation;
 * it establishes neither cancellation authority nor content equivalence. */
export function compareNotamIdentity(previous: NotamRecord, next: NotamRecord) {
  const supplemented = supplementNotamYear(previous, next);
  const [before, after] = supplemented ?? [previous, next];
  return { before, after, fields: identityDifferences(before, after),
    proofs: supplemented ? ['source-year-omission' as const] : [] };
}
