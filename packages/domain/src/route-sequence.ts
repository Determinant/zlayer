import type { RoutePlan, RouteWaypoint } from './route-model.js';

/** Airport bundles stay editable on the map, but are not extra flown endpoints.
 * Retain an intermediate airport actually reached before its departure. */
export function routeFlightSequence(plan: RoutePlan): RouteWaypoint[] {
  const approaches = new Set<string>(), departures = new Set<string>();
  for (const point of plan.waypoints) {
    if (point.approachPhase) approaches.add(point.source.entryId);
    for (const owner of point.owners) {
      const entry = plan.entries[owner.source.tokenIndex];
      if (owner.kind === 'procedure' && entry?.departure?.source === 'cifp' && entry.departure.ident === owner.ident) {
        departures.add(owner.source.entryId);
      }
    }
  }
  const reached = new Set(plan.legs.map(leg => leg.to));
  return plan.waypoints.filter(point => !point.edit || point.layer !== 'airports' ||
    !approaches.has(point.edit.entryId) && (!departures.has(point.edit.entryId) || reached.has(point)));
}
