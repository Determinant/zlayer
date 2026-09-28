import type { GeoPointFeature, NavigationData, PointGeometry } from '@zlayer/contracts';
import { featureIdent, featureKey, featureIdentifiers } from './features.js';
import { nearbyVorStations } from './nearby-navaids.js';
import { distanceNm } from './route.js';
import { routeCoordinateFeature } from './route-coordinate.js';
import { radialReference, type RadialPosition } from './radial-position.js';
import type { RouteDraft, RoutePlan, RouteWaypoint } from './route-model.js';

export type RoutePointForm = { kind: 'coordinate' } | ({ kind: 'radial' } & Omit<RadialPosition, 'coordinate'>);
export type RoutePointIdentification = { key: string; form: RoutePointForm };

/** Stable within the owning entry, independent of expansion order and map rounding. */
export function routeIdentificationKey(point: RouteWaypoint): string {
  return JSON.stringify([featureKey(point.feature), point.feature.geometry.coordinates, point.approachPhase ?? '',
    ...(point.identificationOccurrence ? [point.identificationOccurrence] : [])]);
}

export function routePointLabel(point: RouteWaypoint): string {
  const form = point.identification;
  if (form?.kind === 'coordinate') return featureIdent(routeCoordinateFeature(point.feature.geometry.coordinates));
  const radial = form?.kind === 'radial' ? form : point.radialPosition;
  if (!radial) return point.ident;
  const suffix = radial.reference.bearing === 'true' ? 'T' : radial.reference.bearing === 'magnetic' ? 'M' : '';
  return `${radial.reference.ident}/${String(Math.round(radial.radial) % 360 || 360).padStart(3, '0')}${suffix}/${radial.distanceNm.toFixed(1)}`;
}

export function radialFormsForPoint(coordinate: PointGeometry['coordinates'], navaids: readonly GeoPointFeature[]) {
  return nearbyVorStations(coordinate, navaids).flatMap(station => {
    const reference = radialReference(station.feature);
    return reference && station.radial !== null ? [{ station, form: { kind: 'radial' as const,
      reference, radial: station.radial, distanceNm: station.distanceNm } }] : [];
  });
}

/** Nearby published alternatives are choices, never implicit coordinate snaps. */
export function nearbyNamedRoutePoints(coordinate: PointGeometry['coordinates'], data: NavigationData) {
  const result: Array<{ feature: GeoPointFeature; layer: keyof NavigationData; offsetNm: number }> = [];
  for (const collection of Object.values(data)) for (const feature of collection.features) {
    if (feature.properties.kind === 'coordinate' || Math.abs(coordinate[1] - feature.geometry.coordinates[1]) > 5 / 60 || !featureIdentifiers(feature).length) continue;
    const offsetNm = distanceNm(coordinate, feature.geometry.coordinates);
    if (offsetNm > 5) continue;
    result.push({ feature, layer: collection.meta.layer, offsetNm });
    result.sort((a, b) => a.offsetNm - b.offsetNm || featureKey(a.feature).localeCompare(featureKey(b.feature)));
    if (result.length > 12) result.pop();
  }
  return result;
}

/** Freeze newly resolved typed positions once; future reference updates cannot move them. */
export function captureRadialPositions(draft: RouteDraft, plan: RoutePlan): RouteDraft {
  let changed = false;
  const entries = draft.entries.map(entry => {
    if (entry.radialPosition) return entry;
    const position = plan.waypoints.find(point => point.edit?.entryId === entry.id)?.radialPosition;
    if (!position) return entry;
    changed = true;
    return { ...entry, radialPosition: position };
  });
  return changed ? { entries } : draft;
}
