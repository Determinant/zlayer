import { parseRouteCoordinate, preferredRouteText, type RoutePlan } from '@zlayer/domain';

export type RouteExportFormat = 'skyvector' | 'foreflight' | 'icao';
export const ROUTE_EXPORT_FORMATS: ReadonlyArray<{ id: RouteExportFormat; label: string; description: string }> = [
  { id: 'foreflight', label: 'ForeFlight', description: 'Seconds · latitude/longitude' },
  { id: 'skyvector', label: 'SkyVector / ZLayer', description: 'Seconds · compact coordinates' },
  { id: 'icao', label: 'ICAO / 1800WX', description: 'Coordinates rounded to whole minutes' },
];

/** TEC designators are local shorthand; export their published route instead. */
export function routeExportText(plan: RoutePlan, format: RouteExportFormat = 'skyvector'): string {
  const tecByToken = new Map(plan.tecRoutes.map(tec => [tec.tokenIndex, tec.route]));
  return plan.entries.map((entry, index) => {
    const tec = tecByToken.get(index);
    if (!tec) return entry.text;
    const origin = plan.waypoints.find(point => point.tokenIndex === index - 1)?.feature;
    const destination = plan.waypoints.find(point => point.tokenIndex === index + 1)?.feature;
    const expanded = origin && destination ? preferredRouteText(tec, { origin, destination }) : undefined;
    return expanded ? expanded.split(' ').slice(1, -1).join(' ') : entry.text;
  }).filter(Boolean).join(' ').split(' ').map(token => exportCoordinate(token, format)).join(' ');
}

function exportCoordinate(token: string, format: RouteExportFormat): string {
  if (format === 'skyvector' || !parseRouteCoordinate(token)) return token;
  if (format === 'foreflight') return `${token.slice(0, 7)}/${token.slice(7)}`;
  return `${wholeMinutes(token.slice(0, 6))}${token[6]}${wholeMinutes(token.slice(7, 14))}${token[14]}`;
}

function wholeMinutes(dms: string): string {
  const degrees = Number(dms.slice(0, -4));
  const minutes = Number(dms.slice(-4, -2));
  const seconds = Number(dms.slice(-2));
  const roundedMinutes = degrees * 60 + minutes + (seconds >= 30 ? 1 : 0);
  return String(Math.floor(roundedMinutes / 60)).padStart(dms.length - 4, '0') +
    String(roundedMinutes % 60).padStart(2, '0');
}

export function foreFlightRouteUrl(plan: RoutePlan): string {
  return `foreflightmobile://maps/search?q=${encodeURIComponent(routeExportText(plan, 'foreflight'))}`;
}
