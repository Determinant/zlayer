import { normalizeNavaidType, type RoutePlan, type RouteWaypoint } from '@zlayer/domain';

export function routeWaypointClass(waypoint: Pick<RouteWaypoint, 'layer' | 'feature'>): string {
  if (waypoint.layer === 'navaids' && /^NDB(?:\/DME)?$/.test(normalizeNavaidType(waypoint.feature.properties.type))) return 'is-ndb';
  return `is-${waypoint.layer}`;
}

type RouteTokenState = {
  waypoint: RouteWaypoint | undefined;
  airway: RoutePlan['airways'][number] | undefined;
  procedure: RoutePlan['procedures'][number] | undefined;
  tec: RoutePlan['tecRoutes'][number] | undefined;
  invalid: boolean;
};

/** Match editor entries, excluding geometry-only approach discontinuities. */
export function routeTokenStates(plan: RoutePlan): RouteTokenState[] {
  const waypoints = new Map(plan.waypoints.flatMap(point =>
    point.tokenIndex === undefined ? [] : [[point.tokenIndex, point] as const]));
  const airways = new Map(plan.airways.map(airway => [airway.tokenIndex, airway]));
  const procedures = new Map(plan.procedures.map(procedure => [procedure.tokenIndex, procedure]));
  const tecRoutes = new Map(plan.tecRoutes.map(tec => [tec.tokenIndex, tec]));
  const invalid = new Set(plan.issues.filter(issue => issue.code !== 'approach-discontinuity').map(issue => issue.tokenIndex));
  return plan.entries.map((entry, index) => ({
    waypoint: waypoints.get(index), airway: airways.get(index),
    procedure: entry.departure ? undefined : procedures.get(index), tec: tecRoutes.get(index),
    invalid: invalid.has(index),
  }));
}

export function routeTokenStateClass(token: RouteTokenState & { pending: boolean }): string {
  if (token.invalid) return token.pending ? 'is-pending' : 'is-unresolved';
  if (token.procedure) return 'is-procedure';
  if (token.tec) return 'is-tec';
  if (token.waypoint) return routeWaypointClass(token.waypoint);
  if (token.airway) return 'is-airway';
  return token.pending ? 'is-pending' : 'is-unresolved';
}
