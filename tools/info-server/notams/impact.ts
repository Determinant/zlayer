import type { NotamSourceIssue } from '@zlayer/contracts';
import { notamEndKind, notamTime } from '../../../src/layers/notams/validity';
import { parseIcaoNotice, parseLocalNotice } from '../../../src/layers/notams/representation';
import { noticeIntervalMatches } from '../../../src/layers/notams/source-text';
import { compareNotamRevision } from './revision';

type Interval = { start: number; end: number };
const intervals = new WeakMap<NotamSourceIssue, Interval | null>();
function fixedInterval(issue: NotamSourceIssue): Interval | undefined {
  if (intervals.has(issue)) return intervals.get(issue) ?? undefined;
  intervals.set(issue, null);
  if (issue.reason !== 'revision-conflict' || issue.variants.length < 2 || issue.variantsTruncated || issue.unscoped) return;
  const first = issue.variants[0]!;
  if (first.startsAt === null || first.endsAt === null || first.endsAt <= first.startsAt) return;
  for (const record of issue.variants) {
    if (record.id !== issue.id || compareNotamRevision(record, first) !== 0 || record.lifecycle !== 'active' ||
      record.startsAt !== first.startsAt || record.endsAt !== first.endsAt || notamEndKind(record) !== 'fixed' ||
      notamTime(record.effectiveStart) !== record.startsAt || notamTime(record.effectiveEnd) !== record.endsAt) return;
    // A conflicting or unsupported supplied validity rendering cannot be waived
    // by agreement of the normalized fields alone.
    for (const translation of record.translations) {
      const parsed = translation.type === 'OTHER:ICAO' ? parseIcaoNotice(translation.text)
        : translation.type === 'LOCAL_FORMAT' ? parseLocalNotice(translation.text) : undefined;
      if (!parsed?.ok || !noticeIntervalMatches(record, parsed.value)) return;
    }
  }
  const interval = { start: first.startsAt, end: first.endsAt };
  intervals.set(issue, interval); return interval;
}

/** Historical is an impact assessment, never resolution or source freshness. */
export function assessNotamApplicability(issue: NotamSourceIssue, now: number) {
  const interval = fixedInterval(issue);
  return !interval ? { state: 'unknown' as const, nextTransitionAt: null, fixedEndAt: null }
    : now < interval.start ? { state: 'upcoming' as const, nextTransitionAt: interval.start, fixedEndAt: interval.end }
    : now < interval.end ? { state: 'current' as const, nextTransitionAt: interval.end, fixedEndAt: interval.end }
    : { state: 'historical' as const, nextTransitionAt: null, fixedEndAt: interval.end };
}
