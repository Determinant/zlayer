import { normalizeNavaidType, type RouteWaypoint } from '@zlayer/domain';

export function routeWaypointClass(waypoint: Pick<RouteWaypoint, 'layer' | 'feature'>): string {
  if (waypoint.layer === 'navaids' && /^NDB(?:\/DME)?$/.test(normalizeNavaidType(waypoint.feature.properties.type))) return 'is-ndb';
  return `is-${waypoint.layer}`;
}
