import type { AirportRunwayEnd, GeoPointFeature, GeoPointProperties } from '@zlayer/contracts';
import type { ReactNode } from 'react';
import { runwayEnds, runwayHeading, runwayWindComponents } from '@zlayer/domain';
import { magneticBearing } from '../../../core/geo/magnetic-model';
import { useMetarDeclination } from './use-declination';

export function AirportRunwayWeather({ feature, revision, active, children }: {
  feature: GeoPointFeature; revision: string; active: boolean;
  children: (weather: ReturnType<typeof createRunwayWeather>) => ReactNode;
}) {
  const hasMagneticHeadings = feature.properties.runways?.some(runway => !runway.id.startsWith('H') &&
    runwayEnds(runway).some(end => runwayHeading(end)?.reference === 'magnetic'));
  const declination = useMetarDeclination(feature.geometry.coordinates, feature.properties.metarObservedAt,
    revision, active && !!hasMagneticHeadings);
  return children(createRunwayWeather(feature.properties, declination));
}

export function createRunwayWeather(properties: GeoPointProperties, declination?: number | null) {
  return {
    bestWindEnds: bestWindRunwayEnds(properties, declination),
    notes: <RunwayWindNotes properties={properties} />,
    wind: (end: AirportRunwayEnd) => <RunwayWind end={end} properties={properties} declination={declination} />,
  };
}

/** Keep published or estimated headings paired with wind in the same north reference. */
export function windForRunway(end: AirportRunwayEnd, properties: GeoPointProperties, declination?: number | null) {
  const heading = runwayHeading(end, typeof declination === 'number' && Number.isFinite(declination));
  const magnetic = heading?.reference === 'magnetic';
  const direction = typeof properties.metarWindDirection === 'string' && /^\d{1,3}$/.test(properties.metarWindDirection.trim())
    ? Number(properties.metarWindDirection) : properties.metarWindDirection;
  return runwayWindComponents(heading?.degrees, {
    direction: magnetic && typeof direction === 'number' && Number.isFinite(direction) && direction >= 0 && direction <= 360
      ? magneticBearing(direction, declination!) : direction,
    speedKt: properties.metarWindSpeedKt,
    gustKt: properties.metarWindGustKt,
  });
}

/** Rank usable runway headings, including labeled estimates, by unrounded sustained headwind. */
export function bestWindRunwayEnds(properties: GeoPointProperties, declination?: number | null): string[] {
  const candidates = (properties.runways ?? []).filter(runway => !runway.id.startsWith('H'))
    .flatMap(runwayEnds).flatMap(end => {
      const wind = windForRunway(end, properties, declination);
      return wind.kind === 'directional' && wind.headwindKt > 0
        ? [{ id: end.id, headwind: wind.headwindKt }] : [];
    });
  const best = Math.max(0, ...candidates.map(candidate => candidate.headwind));
  // Preserve parallel/symmetric ties despite floating-point trigonometry noise.
  return candidates.filter(candidate => Math.abs(candidate.headwind - best) < 1e-10)
    .map(candidate => candidate.id);
}

export function RunwayWindNotes({ properties }: { properties: GeoPointProperties }) {
  const variation = properties.rawMetar?.split(/\sRMK\s/)[0]?.match(/\b(\d{3})V(\d{3})\b/);
  const estimated = properties.runways?.some(runway => !runway.id.startsWith('H') &&
    runwayEnds(runway).some(end => runwayHeading(end)?.estimated));
  if (!estimated && !variation) return null;
  return (
    <div className="runway-wind-notes">
      {estimated && <small className="ui-meta">≈ Heading and wind components estimated from runway number.</small>}
      {variation && <small className="ui-meta">Direction varies {variation[1]}–{variation[2]}°T; components use the reported mean.</small>}
    </div>
  );
}

export function RunwayWind({ end, properties, declination }: {
  end: AirportRunwayEnd;
  properties: GeoPointProperties;
  declination?: number | null | undefined;
}) {
  const wind = windForRunway(end, properties, declination);
  if (wind.kind === 'calm') return <p className="ui-meta runway-wind-state">Calm · 0</p>;
  if (wind.kind === 'variable') {
    return <p className="ui-meta runway-wind-state">Variable direction · components unavailable</p>;
  }
  if (wind.kind === 'unavailable') {
    return <p className="ui-meta runway-wind-state">{wind.reason === 'heading'
      ? (runwayHeading(end)?.reference === 'magnetic' ? 'Magnetic reference unavailable' : 'Runway heading unavailable') : wind.reason === 'direction'
      ? 'Wind direction unavailable' : 'METAR wind unavailable'}</p>;
  }
  const side = wind.crosswindKt > 0 ? 'from right' : wind.crosswindKt < 0 ? 'from left' : '';
  const estimated = runwayHeading(end)?.estimated ?? false;
  return (
    <div className="runway-wind-components">
      <WindComponent estimated={estimated} label={wind.headwindKt < 0 ? 'Tailwind' : 'Headwind'}
        direction={wind.headwindKt < 0 ? 'tail' : 'head'} tailwind={wind.headwindKt < 0}
        value={wind.headwindKt} gust={wind.gust?.headwindKt} />
      <WindComponent estimated={estimated} label={`Crosswind ${side}`.trim()}
        direction={wind.crosswindKt > 0 ? 'left' : wind.crosswindKt < 0 ? 'right' : 'cross'}
        value={wind.crosswindKt} gust={wind.gust?.crosswindKt} />
    </div>
  );
}

type WindDirection = 'head' | 'tail' | 'left' | 'right' | 'cross';

function WindArrow({ direction }: { direction: WindDirection }) {
  const rotation = { head: 0, tail: 180, left: 90, right: -90, cross: 0 }[direction];
  return <svg className="runway-wind-arrow" viewBox="0 0 24 24" aria-hidden="true" focusable="false"
    fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path transform={`rotate(${rotation} 12 12)`} d={direction === 'cross'
      ? 'M3 12h18M8 7l-5 5 5 5M16 7l5 5-5 5' : 'M12 3v18M5 14l7 7 7-7'} />
  </svg>;
}

function WindComponent({ label, direction, value, gust, tailwind = false, estimated = false }: {
  label: string; direction: WindDirection; value: number; gust: number | undefined; tailwind?: boolean; estimated?: boolean;
}) {
  const description = `${estimated ? 'Approximate ' : ''}${label}: ${knots(value)} kt${gust === undefined ? '' : `, gust ${knots(gust)} kt`}`;
  return <span className={tailwind ? 'runway-wind-component is-tailwind' : 'runway-wind-component'}
    role="img" aria-label={description} title={description}>
    <WindArrow direction={direction} />
    <strong aria-hidden="true">{knots(value)}{gust !== undefined && <small className="ui-meta">G{knots(gust)}</small>}</strong>
  </span>;
}

function knots(value: number): string {
  const magnitude = Math.abs(value);
  return magnitude > 0 && magnitude < 0.5 ? '<1' : String(Math.round(magnitude));
}
