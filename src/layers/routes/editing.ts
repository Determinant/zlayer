import type { RouteEditTarget, RoutePlan } from '@zlayer/domain';

/** Flat properties survive the MapLibre worker; identity never depends on geometry. */
export function routeEditProperties(target: RouteEditTarget, revision: number) {
  return { editKind: target.kind, editEntryId: target.kind === 'waypoint' ? target.entryId : target.afterEntryId, planRevision: revision };
}
export function routeEditTarget(properties: Record<string, unknown>, plan: RoutePlan): RouteEditTarget | undefined {
  if (properties.planRevision !== plan.revision || typeof properties.editEntryId !== 'string') return undefined;
  if (properties.editKind === 'waypoint') return plan.waypoints.find(point => point.edit?.entryId === properties.editEntryId)?.edit;
  if (properties.editKind === 'leg') return plan.legs.find(leg => leg.edit?.afterEntryId === properties.editEntryId)?.edit;
  return undefined;
}
