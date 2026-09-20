import type { TafReport } from '@zlayer/contracts';
import { tafReportLines } from '@zlayer/domain';
import { formatTimestamp, formatTimestampRange } from '../../../core/format/time';
import type { ReportViewProps } from '../station-weather';
import { TAF_REFRESH_MS } from './client';
import { formatTafLocalTime } from './local-time';

export function TafReportView({ entry, loading, online, now, source, emptyMessage }: ReportViewProps<TafReport>) {
  const report = entry?.report;
  const expired = Boolean(report && report.validTimeTo * 1000 <= now);
  const cancelled = Boolean(report && /\bCNL\b/i.test(report.rawTAF));
  const nil = Boolean(report && /\bNIL\b/i.test(report.rawTAF));
  const cached = Boolean(report && (!online || entry?.error || entry?.missing || entry?.checkedAt === undefined || now - entry.checkedAt > TAF_REFRESH_MS));
  const label = cancelled ? 'Forecast cancelled' : nil ? 'No forecast issued' : expired ? 'Expired forecast'
    : report ? cached ? 'Cached forecast' : 'Updated'
    : loading && online ? 'Loading TAF…' : emptyMessage ?? (!online ? 'No saved TAF · Offline'
    : entry?.error ? 'TAF unavailable · Refresh failed' : 'No TAF available for this airport.');
  return <section className="airport-weather airport-taf" aria-label="TAF" aria-busy={loading}>
    <h3>TAF</h3>
    {source}
    <p className="airport-weather-status" role="status">
      <span className={expired || cached || cancelled ? 'is-cached' : report ? 'is-current' : undefined}>{label}</span>
      {report && !online && <span> · Offline</span>}
      {report && online && entry?.error && <span> · Refresh unavailable</span>}
      {report && online && entry?.missing && <span> · No current forecast returned</span>}
      {report && loading && <span> · Refreshing…</span>}
    </p>
    {report && <div className="taf-dates">
      <span>Issued <time dateTime={report.issueTime}>{formatTimestamp(report.issueTime, { now })}</time></span>
      <span>Valid {formatTimestampRange(report.validTimeFrom * 1000, report.validTimeTo * 1000, { now })}</span>
    </div>}
    {report && <ol className="taf-lines" aria-label="Raw TAF forecast periods">
      {tafReportLines(report).map((line, index) => <li key={index} data-flight-category={line.category ?? 'unknown'}>
        <span className="taf-category" title={line.category ? `${line.category} flight category` : 'Flight category unavailable'}>{line.category ?? 'N/A'}</span>
        <code>{line.text}</code>
        {index === 0 && !cancelled && !nil
          ? <TafLocalTime from={new Date(report.validTimeFrom * 1000).toISOString()} to={new Date(report.validTimeTo * 1000).toISOString()} now={now} />
          : line.fm && <TafLocalTime from={line.fm.time} now={now} />}
      </li>)}
    </ol>}
  </section>;
}

function TafLocalTime({ from, to, now }: { from: string; to?: string; now: number }) {
  return <span className="taf-local-time" title="Device local time">
    {to ? formatTimestampRange(from, to, { now, timeZone: 'local' })
      : <time dateTime={from}>{formatTafLocalTime(from, { now })}</time>}
  </span>;
}
