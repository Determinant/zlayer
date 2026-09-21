import { observationTime, type CachedMetar } from './client';
import { formatCheckedAt, formatDataAge } from '../../../core/format/time';

export function metarReportSummary(entry: CachedMetar | undefined, now = Date.now()) {
  const observedAt = entry?.report ? observationTime(entry.report) : 0;
  const age = observedAt ? now - observedAt : undefined;
  const cached = Boolean(entry?.report && (
    entry.error || entry.missing || entry.checkedAt === undefined ||
    entry.checkedAt > now || now - entry.checkedAt > 90_000 || age === undefined || age < 0 || age > 2 * 60 * 60_000
  ));
  const label = entry?.report ? cached ? 'Cached report' : 'Updated' : 'No report';
  const details: string[] = [];
  if (entry?.error) details.push('Refresh unavailable');
  else if (entry?.missing) details.push('No recent report returned');
  if (entry?.checkedAt !== undefined) {
    details.push(formatCheckedAt(entry.checkedAt, now));
  }
  if (details.length === 0) details.push(entry?.report ? 'Waiting for refresh' : 'No observation received yet');
  return { cached, label, age: entry?.report ? formatDataAge(observedAt || undefined, now) : undefined, details };
}
