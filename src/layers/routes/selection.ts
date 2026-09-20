import type { GeoPointFeature } from '@zlayer/contracts';
import { sameFeature, type RoutePlan, type RouteWaypoint } from '@zlayer/domain';

/** Keep each occurrence distinct, including repeated children of one published item. */
export function routePointKeys(plan: RoutePlan): Map<RouteWaypoint, string> {
  const occurrences = new Map<string, number>();
  return new Map(plan.waypoints.map(point => {
    const occurrence = occurrences.get(point.source.entryId) ?? 0;
    occurrences.set(point.source.entryId, occurrence + 1);
    return [point, point.edit?.entryId ?? `expanded:${JSON.stringify([point.source.entryId, occurrence])}`];
  }));
}

/** Prefer the selected occurrence; the shared details panel always reflects
 * current route membership, including another occurrence after a removal. */
export function routePointForFeature(plan: RoutePlan, feature: GeoPointFeature,
  pointKey?: string): RouteWaypoint | undefined {
  const matches = [...routePointKeys(plan)].filter(([point]) => sameFeature(point.feature, feature));
  return (matches.find(([, key]) => key === pointKey) ?? matches[0])?.[0];
}
