import type { GeoPointFeature } from '@zlayer/contracts';
import { distanceNm, routeIdentificationKey, sameFeature, type RoutePlan, type RouteWaypoint } from '@zlayer/domain';

/** Keep each occurrence distinct, including repeated children of one published item. */
export function routePointKeys(plan: RoutePlan): Map<RouteWaypoint, string> {
  return new Map(plan.waypoints.map(point => [point, point.edit?.entryId ??
    `expanded:${JSON.stringify([point.source.entryId, routeIdentificationKey(point)])}`]));
}

/** Prefer the selected occurrence; the shared details panel always reflects
 * current route membership, including another occurrence after a removal. */
export function routePointForFeature(plan: RoutePlan, feature: GeoPointFeature,
  pointKey?: string): RouteWaypoint | undefined {
  const legacy = legacyApproachPoint(plan, feature);
  if (legacy) return legacy;
  const restored = restoreApproachSelection(plan, feature);
  const matches = [...routePointKeys(plan)].filter(([point]) => sameFeature(point.feature, restored));
  const current = matches.find(([, key]) => key === pointKey)?.[0];
  if (current) return current;
  // Restore the former expansion-index selection format without persisting it anew.
  if (pointKey?.startsWith('expanded:')) {
    try {
      const [entry, index]: unknown[] = JSON.parse(pointKey.slice('expanded:'.length));
      if (typeof entry === 'string' && typeof index === 'number' && Number.isSafeInteger(index) && index >= 0) {
        const candidate = plan.waypoints.filter(point => point.source.entryId === entry)[index];
        if (candidate && matches.some(([point]) => point === candidate)) return candidate;
      }
    } catch { /* Invalid/obsolete saved selection falls back to current membership. */ }
  }
  return matches[0]?.[0];
}

/** Rebind saved approach selections when a navigation entity replaces a coded
 * feature. Read the original coordinate from its ID; map geometry is rounded. */
export function restoreApproachSelection(plan: RoutePlan, feature: GeoPointFeature): GeoPointFeature {
  const legacy = legacyApproachPoint(plan, feature);
  if (legacy) return legacy.feature;
  if (!feature.id?.startsWith('approach-fix:')) return feature;
  const exact = plan.waypoints.find(point => sameFeature(point.feature, feature));
  if (exact) return exact.feature;
  try {
    const value: unknown = JSON.parse(feature.id.slice('approach-fix:'.length));
    if (!Array.isArray(value) || value.length !== 3 || typeof value[0] !== 'string' ||
      !Number.isFinite(value[1]) || !Number.isFinite(value[2])) return feature;
    const matches = plan.waypoints.filter(point => point.ident === value[0] &&
      (point.layer === 'fixes' || point.layer === 'navaids') &&
      distanceNm(point.feature.geometry.coordinates, [value[1], value[2]]) < 0.01);
    return matches.length && matches.every(point => sameFeature(point.feature, matches[0]!.feature))
      ? matches[0]!.feature : feature;
  } catch { return feature; }
}

/** The oldest selection format names the exact occurrence, even for repeated approaches. */
function legacyApproachPoint(plan: RoutePlan, feature: GeoPointFeature): RouteWaypoint | undefined {
  const legacy = /^approach:(.+):(\d+):([^:]+)$/.exec(feature.id ?? '');
  if (!legacy) return;
  const point = plan.waypoints.filter(point => point.source.entryId === legacy[1] &&
    point.owners.some(owner => owner.kind === 'approach'))[Number(legacy[2])];
  return point?.ident === legacy[3] ? point : undefined;
}
