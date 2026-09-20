import { Fragment } from 'react';
import type { MetarFeature } from '@zlayer/contracts';
import { metarWeatherProperties } from '@zlayer/domain';
import type { ReportViewProps } from '../station-weather';
import { metarReportSummary } from './summary';
import { formatObservationTime } from './format';
import { metarDetailRows } from './details';

export function MetarReportView({ entry, loading, online, now, source, emptyMessage }: ReportViewProps<MetarFeature>) {
  const properties = entry?.report ? metarWeatherProperties(entry.report) : undefined;
  const observedAt = properties?.metarObservedAt;
  const weather = metarReportSummary(entry, now);
  const cached = weather.cached || !online;
  const label = entry?.report ? cached ? 'Cached report' : weather.label
    : loading && online ? 'Loading METAR…' : emptyMessage ?? 'No METAR available for this airport.';
  return <section className="airport-weather" aria-label="METAR" aria-busy={loading}>
    <h3>METAR</h3>
    {source}
    <div className="airport-weather-report">
      {observedAt && <time dateTime={observedAt}>{formatObservationTime(observedAt, now)}</time>}
      {weather.age && <span className="airport-weather-age">{weather.age}</span>}
    </div>
    <p className="airport-weather-status" role="status">
      <span className={entry?.report ? cached ? 'is-cached' : 'is-current' : undefined}>{label}</span>
      {entry?.report && weather.details.map(detail => <Fragment key={detail}>{' '}<span>· {detail}</span></Fragment>)}
      {entry?.report && !online && <span> · Offline</span>}
      {entry?.report && loading && <span> · Refreshing…</span>}
    </p>
    {properties && <dl>
      {metarDetailRows(properties).map(({ label, value, wide }) => <div key={label} className={wide ? 'is-wide' : undefined}>
        <dt>{label}</dt><dd>{value}</dd>
      </div>)}
    </dl>}
  </section>;
}
