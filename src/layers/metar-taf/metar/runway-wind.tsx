import type { GeoPointProperties } from '@zlayer/contracts';
import { runwayWindComponents } from '@zlayer/domain';

export function RunwayWindNotes({ properties }: { properties: GeoPointProperties }) {
  const variation = properties.rawMetar?.split(/\sRMK\s/)[0]?.match(/\b(\d{3})V(\d{3})\b/);
  return (
    <div className="runway-wind-notes">
      <small>L/R = from left/right · G = gust</small>
      {variation && <small>Direction varies {variation[1]}–{variation[2]}°T; components use the reported mean.</small>}
    </div>
  );
}

export function RunwayWind({ heading, properties }: {
  heading: number | undefined;
  properties: GeoPointProperties;
}) {
  const wind = runwayWindComponents(heading, {
    direction: properties.metarWindDirection,
    speedKt: properties.metarWindSpeedKt,
    gustKt: properties.metarWindGustKt,
  });
  if (wind.kind === 'calm') return <p className="runway-wind-state">Calm · 0</p>;
  if (wind.kind === 'variable') {
    return <p className="runway-wind-state">Variable direction · components unavailable</p>;
  }
  if (wind.kind === 'unavailable') {
    return <p className="runway-wind-state">{wind.reason === 'heading'
      ? 'True heading unavailable' : wind.reason === 'direction'
      ? 'Wind direction unavailable' : 'METAR wind unavailable'}</p>;
  }
  const side = wind.crosswindKt > 0 ? 'from right' : wind.crosswindKt < 0 ? 'from left' : '';
  return (
    <div className="runway-wind-components">
      <div className={wind.headwindKt < 0 ? 'is-tailwind' : undefined}>
        <span>{wind.headwindKt < 0 ? 'Tailwind' : 'Headwind'}</span>
        <strong>
          {knots(wind.headwindKt)}
          {wind.gust && <small> G{knots(wind.gust.headwindKt)}</small>}
        </strong>
      </div>
      <div>
        <abbr title={`Crosswind ${side}`.trim()}>
          Cross{side === 'from right' ? ' R' : side === 'from left' ? ' L' : ''}
        </abbr>
        <strong>
          {knots(wind.crosswindKt)}
          {wind.gust && <small> G{knots(wind.gust.crosswindKt)}</small>}
        </strong>
      </div>
    </div>
  );
}

function knots(value: number): string {
  const magnitude = Math.abs(value);
  return magnitude > 0 && magnitude < 0.5 ? '<1' : String(Math.round(magnitude));
}
