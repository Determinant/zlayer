import { distanceNm, featureIdent, normalizeRouteCoordinate, parseRadialDefinition, parseRouteCoordinate, preferredRouteText,
  routeCoordinateFeature, routeTokenForFeature, type RoutePlan, type RouteWaypoint } from '@zlayer/domain';
import { pointReplacementProblem } from './identification';

export type RouteExportFormat = 'skyvector' | 'foreflight' | 'icao';
export const ROUTE_EXPORT_FORMATS: ReadonlyArray<{ id: RouteExportFormat; label: string; description: string }> = [
  { id: 'foreflight', label: 'ForeFlight', description: 'Seconds · latitude/longitude' },
  { id: 'skyvector', label: 'SkyVector / ZLayer', description: 'Seconds · compact coordinates' },
  { id: 'icao', label: 'ICAO / 1800WX', description: 'Coordinates rounded to whole minutes' },
];

/** TEC designators are local shorthand; export their published route instead. */
export function routeExportText(plan: RoutePlan, format: RouteExportFormat = 'skyvector'): string {
  const tecByToken = new Map(plan.tecRoutes.map(tec => [tec.tokenIndex, tec.route]));
  const airportNames = new Map(plan.waypoints.filter(point => point.layer === 'airports' && point.edit)
    .map(point => [point.edit!.entryId, routeTokenForFeature(point.feature)]));
  return plan.entries.map((entry, index) => {
    // Shorthand and pins may force an airport alias that means a NAVAID on its own.
    const text = airportNames.get(entry.id) || entry.text;
    if (entry.departure || entry.arrival) return [
      ...(entry.arrival ? [plan.entries[index - 1]?.text === entry.arrival.transition ? '' : entry.arrival.transition, entry.arrival.ident] : []),
      text,
      ...(entry.departure ? [entry.departure.ident, plan.entries[index + 1]?.text === entry.departure.transition ? '' : entry.departure.transition] : []),
    ].filter(Boolean).join(' ');
    const tec = tecByToken.get(index);
    if (!tec) {
      const point = plan.waypoints.find(value => value.edit?.entryId === entry.id);
      return point && (point.identification || point.radialPosition) && !pointReplacementProblem(plan, point)
        ? routePointExport(point, format).text : text;
    }
    const origin = plan.waypoints.find(point => point.tokenIndex === index - 1)?.feature;
    const destination = plan.waypoints.find(point => point.tokenIndex === index + 1)?.feature;
    const expanded = origin && destination ? preferredRouteText(tec, { origin, destination }) : undefined;
    return expanded ? expanded.split(' ').slice(1, -1).join(' ') : entry.text;
  }).filter(Boolean).join(' ').split(' ').map(token => exportCoordinate(token, format)).join(' ');
}

/** One point formatter supplies route copying, sharing and app handoff. */
export function routePointExport(point: RouteWaypoint, format: RouteExportFormat): { text: string; note?: string } {
  const form = point.identification;
  const radial = form?.kind === 'radial' ? form : form?.kind !== 'coordinate' ? point.radialPosition : undefined;
  if (!form && !radial) return { text: exportCoordinate(point.ident, format) };
  if (radial && point.radialReferenceCurrent && Number.isInteger(radial.radial) && Number.isInteger(radial.distanceNm) &&
      radial.distanceNm < 1000 && format !== 'icao' && (format === 'foreflight' || !radial.reference.bearing)) {
    const bearing = String(radial.radial || 360).padStart(3, '0');
    const suffix = radial.reference.bearing === 'true' ? 'T' : radial.reference.bearing === 'magnetic' ? 'M' : '';
    return { text: format === 'foreflight' ? `${radial.reference.ident}/${bearing}${suffix}/${radial.distanceNm}`
      : `${radial.reference.ident}${bearing}${String(radial.distanceNm).padStart(3, '0')}` };
  }
  const text = exportCoordinate(featureIdent(routeCoordinateFeature(point.feature.geometry.coordinates)), format);
  const coordinate = parseRouteCoordinate(normalizeRouteCoordinate(text)!)!;
  const offset = distanceNm(coordinate.geometry.coordinates, point.feature.geometry.coordinates);
  return { text, note: `${radial ? 'Coordinates used to preserve position. ' : ''}${format === 'icao' ? 'Whole minutes' : 'Whole seconds'}; rounding offset ${offset < .001 ? '<0.001' : offset.toFixed(3)} NM.` };
}

export function routeExportNotes(plan: RoutePlan, format: RouteExportFormat): string[] {
  const notes = plan.waypoints.flatMap(point => {
    if (!point.identification && !point.radialPosition) return [];
    if (pointReplacementProblem(plan, point)) return ['Published route identifiers are retained to preserve route constraints.'];
    const note = routePointExport(point, format).note;
    return note ? [note] : [];
  });
  if (plan.entries.some(entry => parseRadialDefinition(entry.text) && !plan.waypoints.some(point => point.edit?.entryId === entry.id))) {
    notes.push('Unresolved radial positions are retained as entered; verify them before using this export.');
  }
  return [...new Set(notes)];
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
