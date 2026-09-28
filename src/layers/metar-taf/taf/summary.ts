import { TAF_REFRESH_MS, type CachedTaf } from './client';

export function tafReportSummary(entry: CachedTaf | undefined, now = Date.now()) {
  const report = entry?.report;
  const expired = Boolean(report && report.validTimeTo * 1000 <= now);
  const cancelled = Boolean(report && /\bCNL\b/i.test(report.rawTAF));
  const nil = Boolean(report && /\bNIL\b/i.test(report.rawTAF));
  const cached = Boolean(report && (entry.error || entry.missing || entry.checkedAt === undefined ||
    entry.checkedAt > now || now - entry.checkedAt > TAF_REFRESH_MS || Date.parse(report.issueTime) > now));
  return { cached, expired, cancelled, nil };
}
