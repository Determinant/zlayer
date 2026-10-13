import { TFR_REFRESH_MS, TFR_DETAIL_REFRESH_MS, type TfrIndexEntry, type TfrNotice, type TfrSourceIssue } from '@zlayer/contracts';
import { tfrDetailFresh } from '../../../src/layers/notams/tfr-time';

// The transport uses these same bounds; planning must account for a full slot.
export const TFR_REQUEST_TIMEOUT_MS = 30_000, TFR_REQUEST_SPACING_MS = 1000;
const REQUEST_SLOT_MS = TFR_REQUEST_TIMEOUT_MS + TFR_REQUEST_SPACING_MS;
const SCHEDULER_TICK_MS = 30_000;
// A deferred queue also waits for admission, the scheduler and the next index.
const NEXT_ROUND_MS = TFR_REFRESH_MS + SCHEDULER_TICK_MS + REQUEST_SLOT_MS;
// Include index requests interleaved with a worst-case serial detail queue.
const queueTime = (count: number) => count * REQUEST_SLOT_MS +
  Math.ceil(count * REQUEST_SLOT_MS / (TFR_REFRESH_MS - REQUEST_SLOT_MS)) * REQUEST_SLOT_MS;

/** Replan after each request against all deferred deadlines. Attempted revisions
 * stay excluded for the round, even when an intervening index check reorders it. */
export function nextTfrDetail({ index, details, issues, attempted, now }: {
  index: readonly TfrIndexEntry[]; details: ReadonlyMap<string, TfrNotice>;
  issues: readonly TfrSourceIssue[]; attempted: ReadonlySet<string>; now: number;
}): TfrIndexEntry | undefined {
  const waiting = index.filter(entry => !attempted.has(`${entry.id}:${entry.modifiedAt}`));
  const unresolved = new Set(issues.map(issue => issue.id));
  const required = waiting.filter(entry => {
    const saved = details.get(entry.id);
    return unresolved.has(entry.id) || saved?.modifiedAt !== entry.modifiedAt || !tfrDetailFresh(saved, now);
  });
  const requiredIds = new Set(required.map(entry => entry.id));
  const reusable = waiting.filter(entry => !requiredIds.has(entry.id)).sort((a, b) =>
    details.get(a.id)!.detailCheckedAt! - details.get(b.id)!.detailCheckedAt! || a.id.localeCompare(b.id));
  const bringForward = reusable.some((entry, position) =>
    details.get(entry.id)!.detailCheckedAt! + TFR_DETAIL_REFRESH_MS <=
      now + NEXT_ROUND_MS + queueTime(required.length + position + 1));
  return bringForward ? reusable[0] : required[0];
}

/** Healthy details can need another round before the next index poll. Failed
 * members keep the index cadence instead of creating a tight detail-only loop. */
export function nextTfrDetailAt(details: Iterable<TfrNotice>, hasIssues: boolean, now: number): number {
  if (hasIssues) return Infinity;
  const deadlines = [...details].map(notice => (notice.detailCheckedAt ?? 0) + TFR_DETAIL_REFRESH_MS).sort((a, b) => a - b);
  return deadlines.length ? Math.max(now, Math.min(...deadlines.map((deadline, position) =>
    deadline - SCHEDULER_TICK_MS - queueTime(position + 1)))) : Infinity;
}
