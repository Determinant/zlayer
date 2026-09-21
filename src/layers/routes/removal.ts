import { createRouteEntry, type RouteDraft, type RouteEntry, type RoutePlan, type RouteWaypoint } from '@zlayer/domain';
import { sameRouteDraft } from './draft';

/** Published items which supply this point, or depend on it as an endpoint. */
export function routeItemsForPoint(plan: RoutePlan, point: RouteWaypoint): RouteEntry[] {
  const tec = new Set(plan.tecRoutes.map(item => item.tokenIndex));
  const airways = new Set(plan.airways.map(item => item.tokenIndex).filter(index => !tec.has(index)));
  const published = new Set([...tec, ...airways, ...plan.procedures.filter(item => !plan.entries[item.tokenIndex]?.departure && !plan.entries[item.tokenIndex]?.arrival).map(item => item.tokenIndex)]);
  return [...published].sort((a, b) => a - b).filter(index => {
    let first = index, last = index;
    // An inferred airway junction depends on the whole adjacent airway chain.
    if (airways.has(index)) {
      while (airways.has(first - 1)) first--;
      while (airways.has(last + 1)) last++;
    }
    return point.source.tokenIndex >= first - 1 && point.source.tokenIndex <= last + 1;
  }).map(index => plan.entries[index]!);
}

/** Replace only affected published items with their displayed waypoints. Other
 * entries, exact feature pins and unresolved input remain intact. */
export function removeRoutePoint(draft: RouteDraft, plan: RoutePlan, point: RouteWaypoint): RouteDraft {
  // Coded procedure children cannot be flattened into ordinary editable fixes.
  if (point.owners.some(owner => owner.kind === 'approach')) return draft;
  if (!point.edit && (plan.entries[point.source.tokenIndex]?.departure || plan.entries[point.source.tokenIndex]?.arrival)) return draft;
  if (!plan.waypoints.includes(point) || !sameRouteDraft(draft, plan)) return draft;
  const expand = new Set(routeItemsForPoint(plan, point).map(entry => entry.id));
  if (!point.edit) expand.add(point.source.entryId);
  return { entries: draft.entries.flatMap(entry => {
    if (point.edit?.entryId === entry.id) return [];
    if (!expand.has(entry.id)) return [entry];
    return plan.waypoints.filter(candidate => candidate.source.entryId === entry.id && candidate !== point)
      .map(candidate => createRouteEntry(candidate.ident, candidate.feature.id));
  }) };
}
