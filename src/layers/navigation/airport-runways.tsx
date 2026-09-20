import type { AirportRunwayEnd, GeoPointFeature } from '@zlayer/contracts';
import { RunwayWind, RunwayWindNotes } from '../metar-taf';

export function AirportRunways({ feature }: { feature: GeoPointFeature }) {
  const runways = feature.properties.runways;
  const hasHelipads = runways?.some(runway => runway.id.startsWith('H'));
  const hasRunways = runways?.some(runway => !runway.id.startsWith('H'));
  const title = hasHelipads ? hasRunways ? 'Runways & helipads' : 'Helipads' : 'Runways';
  return (
    <section className="airport-runways" aria-label={title}>
      <h3>{title}</h3>
      {runways?.length ? (
        <>
          {hasRunways && <RunwayWindNotes properties={feature.properties} />}
          {runways.map(runway => runway.id.startsWith('H') ? (
            <div className="airport-helipad" key={runway.id}>
              <strong>{runway.id}</strong>
              <span>Helipad · {dimensions(runway.lengthFt, runway.widthFt)}{runway.surface && ` · ${runway.surface}`}</span>
            </div>
          ) : (
            <table className="airport-runway" key={runway.id}>
              <caption>
                <strong>{runway.id}</strong>
                <span>{dimensions(runway.lengthFt, runway.widthFt)}{runway.surface && ` · ${runway.surface}`}</span>
              </caption>
              <thead>
                <tr>
                  <th scope="col">RWY</th>
                  <th scope="col">Pattern</th>
                  <th scope="col">Wind <span>(kt)</span></th>
                </tr>
              </thead>
              <tbody>
                {(runway.ends?.length ? runway.ends : runway.id.split('/').map((id): AirportRunwayEnd => ({ id }))).map(end => {
                  // AIM 4-3-3 defaults to left turns, with an exception for helicopters.
                  const pattern = end.trafficPattern ?? (end.id.startsWith('H') ? undefined : 'left');
                  return (
                    <tr className="runway-end" key={end.id}>
                      <th scope="row" className="runway-end-heading">
                        <strong>{end.id}</strong>
                        {end.trueHeadingDeg !== undefined && (
                          <small>{String(end.trueHeadingDeg || 360).padStart(3, '0')}°T</small>
                        )}
                      </th>
                      <td className="runway-pattern">
                        <span title={pattern === 'right' ? 'Right traffic' : pattern === 'left'
                          ? (end.trafficPattern ? 'Left traffic' : 'Left traffic (default; AIM 4-3-3)')
                          : 'Pattern not published'}>
                          {pattern === 'right' ? 'Right' : pattern === 'left' ? 'Left' : '—'}
                        </span>
                      </td>
                      <td><RunwayWind heading={end.trueHeadingDeg} properties={feature.properties} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ))}
        </>
      ) : <p className="runway-empty">No runways published.</p>}
    </section>
  );
}

function dimensions(length: number | undefined, width: number | undefined): string {
  if (length === undefined) return 'Dimensions unavailable';
  return `${length.toLocaleString()}${width === undefined ? '' : ` × ${width.toLocaleString()}`} ft`;
}
