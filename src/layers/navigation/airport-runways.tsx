import type { AirportRunwayEnd, GeoPointFeature } from '@zlayer/contracts';
import { runwayEnds, runwayHeading } from '@zlayer/domain';
import type { ReactNode } from 'react';

export type RunwayWeather = {
  notes: ReactNode;
  wind(end: AirportRunwayEnd): ReactNode;
  bestWindEnds?: readonly string[];
};

export function AirportRunways({ feature, weather }: { feature: GeoPointFeature; weather?: RunwayWeather | undefined }) {
  const runways = feature.properties.runways;
  const hasHelipads = runways?.some(runway => runway.id.startsWith('H'));
  const hasRunways = runways?.some(runway => !runway.id.startsWith('H'));
  const title = hasHelipads ? hasRunways ? 'Runways & helipads' : 'Helipads' : 'Runways';
  return (
    <section className="ui-section airport-runways" aria-label={title}>
      <h3 className="ui-section-title">{title}</h3>
      {runways?.length ? (
        <>
          {hasRunways && weather?.notes}
          {runways.map(runway => runway.id.startsWith('H') ? (
            <div className="airport-helipad" key={runway.id}>
              <strong>{runway.id}</strong>
              <span>Helipad · {dimensions(runway.lengthFt, runway.widthFt)}{runway.surface && ` · ${runway.surface}`}</span>
            </div>
          ) : (
            <div className="airport-runway-scroll" key={runway.id} tabIndex={0}
              role="region" aria-label={`${runway.id} runway details`}>
              <table className="ui-data-table airport-runway">
                <caption>
                  <strong>{runway.id}</strong>
                  <span>{dimensions(runway.lengthFt, runway.widthFt)}{runway.surface && ` · ${runway.surface}`}</span>
                </caption>
                <thead>
                  <tr>
                    <th scope="col">RWY</th>
                    <th scope="col">Pattern</th>
                    {weather && <th scope="col">Wind <span>(kt)</span></th>}
                  </tr>
                </thead>
                <tbody>
                  {runwayEnds(runway).map(end => {
                    const heading = runwayHeading(end);
                    // AIM 4-3-3 defaults to left turns, with an exception for helicopters.
                    const pattern = end.trafficPattern ?? (end.id.startsWith('H') ? undefined : 'left');
                    return (
                      <tr className="runway-end" key={end.id}>
                        <th scope="row" className="runway-end-heading">
                          <span className="runway-end-identity">
                            <span className="runway-end-reference">
                              <strong>{end.id}</strong>
                              {heading && (
                                <small title={heading.estimated ? 'Approximate magnetic heading from runway number' : undefined}>
                                  {heading.estimated && '≈'}{String(heading.degrees || 360).padStart(3, '0')}°{heading.reference === 'magnetic' ? 'M' : 'T'}
                                </small>
                              )}
                            </span>
                            {weather?.bestWindEnds?.includes(end.id) && (
                              <span className="runway-best-wind"
                                title={`Greatest headwind from the reported METAR.${heading?.estimated ? ' Uses approximate runway heading.' : ''} Wind only; not the active runway.`}>Best Wind</span>
                            )}
                          </span>
                        </th>
                        <td className="runway-pattern">
                          <span title={pattern === 'right' ? 'Right traffic' : pattern === 'left'
                            ? (end.trafficPattern ? 'Left traffic' : 'Left traffic (default; AIM 4-3-3)')
                            : 'Pattern not published'}>
                            {pattern === 'right' ? 'Right' : pattern === 'left' ? 'Left' : '—'}
                          </span>
                        </td>
                        {weather && <td>{weather.wind(end)}</td>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
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
