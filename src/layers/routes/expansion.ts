import { createRouteEntry, featureIdentifiers, routePointIdentifications, routeTokenForFeature, type RouteDraft, type RouteEntry, type RoutePlan } from '@zlayer/domain';
import { entryForRoutePoint, sameRouteDraft } from './draft';

/** Expand only this occurrence's immediate children. A TEC's nested airway
 * diagnostics do not prevent exposing its intact published shorthand. */
export function routeEntryExpansion(plan: RoutePlan, entryId: string): RouteEntry[] | undefined {
  const index = plan.entries.findIndex(entry => entry.id === entryId);
  if (index < 0) return;
  const tec = plan.tecRoutes.find(item => item.tokenIndex === index);
  if (tec) return tec.children.map((child, childIndex) => {
    const identifications = routePointIdentifications(plan.waypoints.filter(point =>
      point.source.entryId === entryId && point.source.tecChildIndex === childIndex));
    return { ...createRouteEntry(child.text, child.pinnedFeatureId),
      ...(identifications.length ? { identifications } : {}) };
  });

  const airway = plan.airways.find(item => item.tokenIndex === index);
  if (!airway || plan.issues.some(issue => issue.tokenIndex === index)) return;
  const firstChild = plan.waypoints.findIndex(point => point.owners.some(owner =>
    owner.kind === 'airway' && owner.source.entryId === entryId));
  if (firstChild < 1) return;
  // Airway ownership starts after the entry fix (which can belong to the
  // previous airway), and includes the exit fix.
  const points = plan.waypoints.slice(firstChild - 1, firstChild - 1 + airway.points.length);
  // Both endpoints must be resolved too; a missing explicit anchor can report
  // its diagnostic on the neighboring entry instead of on the airway.
  if (points.length !== airway.points.length || points.some((point, i) =>
    !featureIdentifiers(point.feature).includes(airway.points[i]!.ident))) return;
  const children = points.filter((point, i) => {
    // Keep inferred junctions beside an unexpanded airway, but do not duplicate
    // an endpoint already authored immediately before or after this item.
    const neighbor = i === 0 ? plan.entries[index - 1] : i === points.length - 1 ? plan.entries[index + 1] : undefined;
    return !neighbor || point.edit?.entryId !== neighbor.id;
  }).map(entryForRoutePoint);
  return children;
}

export function expandRouteEntry(draft: RouteDraft, plan: RoutePlan, entryId: string): RouteDraft {
  if (!sameRouteDraft(draft, plan)) return draft;
  const children = routeEntryExpansion(plan, entryId);
  if (!children) return draft;
  // Match inline replacement: the first child inherits the selected entry ID.
  if (children[0]) children[0] = { ...children[0], id: entryId };
  const index = plan.entries.findIndex(entry => entry.id === entryId);
  const tec = plan.tecRoutes.some(item => item.tokenIndex === index);
  return { entries: draft.entries.flatMap((entry, at) => {
    if (entry.id === entryId) return children;
    // TEC matching can disambiguate a short airport alias from a navaid. Keep
    // that exact airport when the TEC no longer supplies the constraint.
    if (tec && (at === index - 1 || at === index + 1)) {
      const airport = plan.waypoints.find(point => point.edit?.entryId === entry.id && point.layer === 'airports');
      if (!entry.pinnedFeatureId && airport?.feature.id && entry.text !== routeTokenForFeature(airport.feature)) {
        return [{ ...entry, pinnedFeatureId: airport.feature.id }];
      }
    }
    return [entry];
  }) };
}
