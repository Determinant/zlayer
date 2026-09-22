import type { GeoPointFeature, NavigationData, PreferredRouteRecord } from '@zlayer/contracts';
import { createRouteEntry, routeEntriesFromText, routeDraftFromText, routeTokenForFeature, resolvePreferredRouteEntries,
  airportRouteIdent, type RouteAirportPair, type RouteApproach, type RouteTerminal, type RouteDraft, type RouteEntry } from '@zlayer/domain';

export { routeDraftFromText, routeDraftText } from '@zlayer/domain';
export type { RouteDraft } from '@zlayer/domain';
export const EMPTY_ROUTE_DRAFT: RouteDraft = { entries: [] };

export function preferredRouteDraft(route: PreferredRouteRecord, pair: RouteAirportPair,
  navigation: NavigationData = {}): RouteDraft | undefined {
  if (route.routeType === 'TEC' && route.designator) {
    return routeDraftFromText(`${airportRouteIdent(pair.origin)} ${route.designator} ${airportRouteIdent(pair.destination)}`, {
      ...(pair.origin.id ? { 0: pair.origin.id } : {}), ...(pair.destination.id ? { 2: pair.destination.id } : {}),
    });
  }
  const entries = resolvePreferredRouteEntries(route, pair, navigation);
  return entries ? { entries: entries.map(entry => createRouteEntry(entry.text, entry.pinnedFeatureId)) } : undefined;
}
export function appendRouteText(draft: RouteDraft, input: string): RouteDraft {
  const additions = routeEntriesFromText(input);
  return additions.length ? { entries: [...draft.entries, ...additions] } : draft;
}
export function insertRouteTextBefore(draft: RouteDraft, beforeEntryId: string, input: string): RouteDraft {
  const index = draft.entries.findIndex(entry => entry.id === beforeEntryId);
  const additions = routeEntriesFromText(input);
  return index < 0 || !additions.length ? draft : spliceEntries(draft, index, 0, additions);
}
export function replaceRouteText(draft: RouteDraft, entryId: string, input: string): RouteDraft {
  const index = draft.entries.findIndex(entry => entry.id === entryId);
  if (index < 0) return draft;
  const replacements = routeEntriesFromText(input);
  if (!replacements.length || replacements.length === 1 && replacements[0]!.text === draft.entries[index]!.text) return draft;
  // Keep the edited entry's identity, but resolve its new text without the old feature pin.
  replacements[0] = { id: entryId, text: replacements[0]!.text };
  return spliceEntries(draft, index, 1, replacements);
}
export function appendRouteFeature(draft: RouteDraft, feature: GeoPointFeature): RouteDraft {
  const entry = entryForFeature(feature);
  return entry ? { entries: [...draft.entries, entry] } : draft;
}
export function insertRouteFeature(draft: RouteDraft, afterEntryId: string, feature: GeoPointFeature): RouteDraft {
  const index = draft.entries.findIndex(entry => entry.id === afterEntryId);
  const entry = entryForFeature(feature);
  return index < 0 || !entry ? draft : spliceEntries(draft, index + 1, 0, [entry]);
}
export function replaceRouteFeature(draft: RouteDraft, entryId: string, feature: GeoPointFeature): RouteDraft {
  const index = draft.entries.findIndex(entry => entry.id === entryId);
  const entry = entryForFeature(feature, entryId);
  if (index < 0 || !entry) return draft;
  const previous = draft.entries[index]!;
  return previous.text === entry.text && previous.pinnedFeatureId === entry.pinnedFeatureId
    ? draft : spliceEntries(draft, index, 1, [entry]);
}
export function removeRouteEntry(draft: RouteDraft, entryId: string): RouteDraft {
  const index = draft.entries.findIndex(entry => entry.id === entryId);
  return index < 0 ? draft : spliceEntries(draft, index, 1);
}
/** The expected entry prevents a late picker action from changing a replaced airport. */
export function setRouteApproach(draft: RouteDraft, expected: RouteEntry, approach: RouteApproach | undefined): RouteDraft {
  const index = draft.entries.indexOf(expected);
  if (index < 0 || sameRouteApproach(expected.approach, approach)) return draft;
  const { approach: _previous, ...airport } = expected;
  return spliceEntries(draft, index, 1, [{ ...airport, ...(approach ? { approach } : {}) }]);
}
export function sameRouteApproach(left: RouteApproach | undefined, right: RouteApproach | undefined): boolean {
  return left === right || !!left && !!right && left.airportId === right.airportId &&
    left.procedureId === right.procedureId && left.name === right.name && left.cycle === right.cycle &&
    left.source === right.source &&
    left.entry?.routeId === right.entry?.routeId && left.entry?.transitionId === right.entry?.transitionId &&
    left.entry?.name === right.entry?.name && left.entry?.effectiveDate === right.entry?.effectiveDate;
}
export function setRouteDeparture(draft: RouteDraft, expected: RouteEntry, departure: RouteTerminal | undefined): RouteDraft {
  const index = draft.entries.indexOf(expected);
  if (index < 0 || departure && departure.kind !== 'departure' || sameRouteTerminal(expected.departure, departure)) return draft;
  const { departure: _previous, ...airport } = expected;
  return spliceEntries(draft, index, 1, [{ ...airport, ...(departure ? { departure } : {}) }]);
}
export function sameRouteTerminal(left: RouteTerminal | undefined, right: RouteTerminal | undefined): boolean {
  return left === right || !!left && !!right && left.airportId === right.airportId && left.procedureId === right.procedureId &&
    left.kind === right.kind && left.source === right.source && left.ident === right.ident && left.name === right.name && left.effectiveDate === right.effectiveDate &&
    left.transition === right.transition && left.branchId === right.branchId && left.branchName === right.branchName &&
    left.codedRunway === right.codedRunway && JSON.stringify(left.codedBranches) === JSON.stringify(right.codedBranches);
}
export function setRouteArrival(draft: RouteDraft, expected: RouteEntry, arrival: RouteTerminal | undefined): RouteDraft {
  const index = draft.entries.indexOf(expected);
  if (index < 0 || arrival && arrival.kind !== 'arrival' || sameRouteTerminal(expected.arrival, arrival)) return draft;
  const { arrival: _previous, ...airport } = expected;
  return spliceEntries(draft, index, 1, [{ ...airport, ...(arrival ? { arrival } : {}) }]);
}
/** Compare authored entries, including exact entity pins and procedure choices.
 * A newly resolved plan may share the same draft despite a new revision. */
export function sameRouteDraft(left: RouteDraft, right: RouteDraft): boolean {
  return left.entries.length === right.entries.length && left.entries.every((entry, index) => {
    const other = right.entries[index]!;
    return entry.id === other.id && entry.text === other.text && entry.pinnedFeatureId === other.pinnedFeatureId &&
      sameRouteApproach(entry.approach, other.approach) && sameRouteTerminal(entry.departure, other.departure) &&
      sameRouteTerminal(entry.arrival, other.arrival);
  });
}
export function moveRouteEntry(draft: RouteDraft, fromEntryId: string, toEntryId: string): RouteDraft {
  const from = draft.entries.findIndex(entry => entry.id === fromEntryId);
  const to = draft.entries.findIndex(entry => entry.id === toEntryId);
  if (from < 0 || to < 0 || from === to) return draft;
  const entries = [...draft.entries];
  const [entry] = entries.splice(from, 1);
  entries.splice(to, 0, entry!);
  return { entries };
}
function spliceEntries(draft: RouteDraft, index: number, count: number, additions: RouteEntry[] = []): RouteDraft {
  const entries = [...draft.entries];
  entries.splice(index, count, ...additions);
  return { entries };
}
function entryForFeature(feature: GeoPointFeature, id?: string): RouteEntry | undefined {
  const text = routeTokenForFeature(feature);
  return text ? createRouteEntry(text, feature.id, id) : undefined;
}
