import { isRecord } from '@zlayer/contracts';
import { routeTokensFromText, type RouteDraft, type RouteEntry } from '@zlayer/domain';

/** Shared boundary for active drafts and saved routes. Never mutates stored records. */
export function parseRouteEntries(value: unknown): RouteDraft | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = new Set<string>();
  const entries: RouteEntry[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id) ||
      typeof entry.text !== 'string' || routeTokensFromText(entry.text).length !== 1 ||
      routeTokensFromText(entry.text)[0] !== entry.text) return undefined;
    ids.add(entry.id);
    const approach = entry.approach;
    const departure = entry.departure;
    const approachEntry = isRecord(approach) && isRecord(approach.entry) ? approach.entry : undefined;
    entries.push({ id: entry.id, text: entry.text,
      ...(typeof entry.pinnedFeatureId === 'string' && entry.pinnedFeatureId ? { pinnedFeatureId: entry.pinnedFeatureId } : {}),
      ...(isRecord(departure) && ['airportId', 'procedureId', 'ident', 'name', 'effectiveDate', 'transition'].every(field =>
        typeof departure[field] === 'string' && departure[field].trim().length > 0)
        ? { departure: { airportId: departure.airportId as string, procedureId: departure.procedureId as string,
          ident: departure.ident as string, name: departure.name as string, effectiveDate: departure.effectiveDate as string,
          transition: departure.transition as string,
          ...(typeof departure.branchId === 'string' && departure.branchId ? { branchId: departure.branchId } : {}),
          ...(typeof departure.branchName === 'string' && departure.branchName ? { branchName: departure.branchName } : {}) } } : {}),
      // Discard a malformed attachment without discarding the airport or route.
      ...(isRecord(approach) && ['airportId', 'procedureId', 'name', 'cycle'].every(field =>
        typeof approach[field] === 'string' && approach[field].trim().length > 0)
        ? { approach: { airportId: approach.airportId as string, procedureId: approach.procedureId as string,
          name: approach.name as string, cycle: approach.cycle as string,
          ...(approachEntry && ['routeId', 'transitionId', 'name', 'effectiveDate'].every(field =>
            typeof approachEntry[field] === 'string' && (approachEntry[field] as string).trim().length > 0)
            ? { entry: { routeId: approachEntry.routeId as string, transitionId: approachEntry.transitionId as string,
              name: approachEntry.name as string, effectiveDate: approachEntry.effectiveDate as string } } : {}) } } : {}) });
  }
  return { entries };
}
