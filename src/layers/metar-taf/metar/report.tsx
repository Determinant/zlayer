import { Fragment, useMemo } from 'react';
import type { MetarFeature } from '@zlayer/contracts';
import { metarWeatherProperties } from '@zlayer/domain';
import type { ReportViewProps } from '../station-weather';
import { metarReportSummary } from './summary';
import { formatObservationTime } from './format';
import { metarDetailRows } from './details';
import { magneticField } from '../../../core/geo/magnetic-model';
import { useMagneticModel } from '../../../core/geo/use-magnetic-model';
import { fetchMagneticModel } from '../../../workspace/catalog/catalog';

export function MetarReportView({ entry, loading, online, now, source, emptyMessage, revision, active = true }: ReportViewProps<MetarFeature>) {
  const properties = entry?.report ? metarWeatherProperties(entry.report) : undefined;
  const observedAt = properties?.metarObservedAt;
  const model = useMagneticModel(revision, active && !!entry?.report, fetchMagneticModel);
  const [longitude, latitude] = entry?.report?.geometry.coordinates ?? [];
  const field = useMemo(() => model && longitude !== undefined && latitude !== undefined && observedAt
    ? magneticField(model, [longitude, latitude], 0, Date.parse(observedAt)) : null,
  [model, longitude, latitude, observedAt]);
  const declination = field && field.horizontal >= 6000 && Math.abs(latitude!) < 90 ? field.declination : null;
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
      {metarDetailRows(properties, declination).map(({ label, value, wide }) => <div key={label} className={wide ? 'is-wide' : undefined}>
        <dt>{label}</dt><dd>{value}</dd>
      </div>)}
    </dl>}
  </section>;
}
