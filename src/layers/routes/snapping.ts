import type { GeoPointFeature } from '@zlayer/contracts';
import { featureKey, sameFeature } from '@zlayer/domain';

export const ROUTE_SNAP_RADIUS_PX = 24;
const RELEASE_RADIUS_PX = 36;
const HIT_RELEASE_MARGIN_PX = 12;
const SWITCH_MARGIN_PX = 6;

export type SnapBounds = [left: number, top: number, right: number, bottom: number];
export type RouteSnap = { feature: GeoPointFeature; bounds: SnapBounds };

/** Keep a captured entity through label placement/source refreshes and small
 * pointer movements. Candidates retain the map's rendered label/icon hit area;
 * anchor distances rank hits without narrowing their capture area. */
export function routeSnapFeature(candidates: readonly GeoPointFeature[], previous: RouteSnap | undefined,
  offset: (feature: GeoPointFeature) => readonly [number, number], capture: (feature: GeoPointFeature) => SnapBounds): RouteSnap | undefined {
  const previousOffset = previous ? offset(previous.feature) : [Infinity, Infinity];
  const previousDistance = Math.hypot(previousOffset[0]!, previousOffset[1]!);
  const previousHit = previous && candidates.some(feature => sameFeature(previous.feature, feature));
  let nearest: GeoPointFeature | undefined;
  let nearestDistance = Infinity;
  for (const feature of candidates) {
    const candidateDistance = Math.hypot(...offset(feature));
    if (Number.isFinite(candidateDistance) && (candidateDistance < nearestDistance || candidateDistance === nearestDistance &&
      (!nearest || featureKey(feature) < featureKey(nearest)))) {
      nearest = feature;
      nearestDistance = candidateDistance;
    }
  }
  const margin = ROUTE_SNAP_RADIUS_PX + HIT_RELEASE_MARGIN_PX;
  const retained = previous && Number.isFinite(previousDistance) && (previousHit || previousDistance <= RELEASE_RADIUS_PX ||
    previousOffset[0]! >= previous.bounds[0] - margin && previousOffset[0]! <= previous.bounds[2] + margin &&
    previousOffset[1]! >= previous.bounds[1] - margin && previousOffset[1]! <= previous.bounds[3] + margin);
  if (retained && (!nearest || sameFeature(previous.feature, nearest) || nearestDistance + SWITCH_MARGIN_PX >= previousDistance)) {
    // Capture bounds never grow with pointer motion or missing rendered hits.
    return previous;
  }
  return nearest ? { feature: nearest, bounds: capture(nearest) } : undefined;
}
