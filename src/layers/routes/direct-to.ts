import type { GeoPointFeature, PointGeometry } from '@zlayer/contracts';
import { createRouteEntry, routeCoordinateFeature, routeTokenForFeature,
  type RouteDraft, type RoutePlan, type RouteWaypoint } from '@zlayer/domain';
import type { OwnshipSnapshot } from '../ownship/layer';
import { GPS_STALE_MS } from '../ownship/position';
import { routeItemsForPoint } from './removal';
import { sameRouteApproach } from './draft';

export type DirectToAction = (feature: GeoPointFeature, point?: RouteWaypoint) => void;

/** A retained last position is not a current fix. Recheck even after a modal closes. */
export function directToPosition({ state, fix }: OwnshipSnapshot, now = Date.now()): PointGeometry['coordinates'] | undefined {
  return state === 'tracking' && fix && now - fix.timestamp < GPS_STALE_MS
    ? fix.coordinates : undefined;
}

export function routeDraftMatchesPlan(draft: RouteDraft, plan: RoutePlan): boolean {
  return draft.entries.length === plan.entries.length && draft.entries.every((entry, index) => {
    const resolved = plan.entries[index]!;
    return entry.id === resolved.id && entry.text === resolved.text && entry.pinnedFeatureId === resolved.pinnedFeatureId &&
      sameRouteApproach(entry.approach, resolved.approach);
  });
}

/** Trim to the selected occurrence, expanding only published items whose context
 * is cut away. Unrelated entries and unresolved suffix input stay intact. */
export function directToRoutePoint(draft: RouteDraft, plan: RoutePlan, point: RouteWaypoint,
  position: PointGeometry['coordinates']): RouteDraft {
  const index = plan.waypoints.indexOf(point);
  if (index < 0 || !routeDraftMatchesPlan(draft, plan)) return draft;
  const remaining = plan.waypoints.slice(index);
  const expand = directToExpansion(plan, point);
  if (expansionProblem(plan, point, remaining, expand)) return draft;
  const entries = draft.entries.slice(point.source.tokenIndex).flatMap(entry => {
    if (expand.has(entry.id)) return remaining.filter(candidate => candidate.source.entryId === entry.id)
      .map(candidate => entryForPoint(candidate.feature));
    // Pin the target so resolving from the new GPS origin cannot select a
    // different navigation feature with the same identifier.
    if (entry.id === point.edit?.entryId && point.feature.id) return [{ ...entry, pinnedFeatureId: point.feature.id }];
    return [entry];
  });
  return { entries: [entryForPoint(routeCoordinateFeature(position)), ...entries] };
}

/** A plain waypoint draft cannot represent a published gap or missing child.
 * Explain refusals before editing; the draft operation enforces the same guard. */
export function directToRouteProblem(plan: RoutePlan, point: RouteWaypoint): string | undefined {
  const index = plan.waypoints.indexOf(point);
  return index < 0 ? undefined : expansionProblem(plan, point, plan.waypoints.slice(index), directToExpansion(plan, point));
}

function directToExpansion(plan: RoutePlan, point: RouteWaypoint): Set<string> {
  const expand = new Set(point.edit ? [] : routeItemsForPoint(plan, point).map(entry => entry.id));
  if (!point.edit) expand.add(point.source.entryId);
  // A top-level SID can no longer use the original airport as the route origin.
  // TEC children have their own airport scope, which remains valid when intact.
  const tec = new Set(plan.tecRoutes.map(item => item.tokenIndex));
  for (const procedure of plan.procedures) {
    if (procedure.kind === 'departure' && !tec.has(procedure.tokenIndex)) {
      expand.add(plan.entries[procedure.tokenIndex]!.id);
    }
  }
  return expand;
}

function expansionProblem(plan: RoutePlan, point: RouteWaypoint, remaining: RouteWaypoint[], expand: Set<string>): string | undefined {
  if (point.owners.some(owner => owner.kind === 'approach')) return 'Choose an approach entry from the airport’s approach bundle to preserve the published procedure.';
  if (point.edit && plan.entries[point.source.tokenIndex]?.approach?.entry) return 'Remove the attached approach before going directly to the airport.';
  const issue = plan.issues.find(issue => issue.tokenIndex >= point.source.tokenIndex &&
    expand.has(plan.entries[issue.tokenIndex]!.id));
  if (issue) return `Direct to cannot preserve the remaining ${issue.token} route: ${issue.message}.`;

  // Each slot represents an output entry. An unchanged published or unresolved
  // entry stays between its neighbors and retains its own connectivity rules.
  const slots = plan.entries.slice(point.source.tokenIndex).flatMap(entry => {
    if (expand.has(entry.id)) return remaining.filter(candidate => candidate.source.entryId === entry.id);
    return [remaining.find(candidate => candidate.edit?.entryId === entry.id)];
  });
  for (let i = 1; i < slots.length; i++) {
    const from = slots[i - 1], to = slots[i];
    if (from?.edit && plan.entries[from.source.tokenIndex]?.approach || to?.edit && plan.entries[to.source.tokenIndex]?.approach) continue;
    if (from && to && !plan.legs.some(leg => leg.from === from && leg.to === to)) {
      return `Direct to would connect ${from.ident} to ${to.ident} across a route discontinuity.`;
    }
  }
  return undefined;
}

export function directToFeature(feature: GeoPointFeature, position: PointGeometry['coordinates']): RouteDraft {
  return { entries: [entryForPoint(routeCoordinateFeature(position)), entryForPoint(feature)] };
}

function entryForPoint(feature: GeoPointFeature) {
  return createRouteEntry(routeTokenForFeature(feature), feature.id);
}
