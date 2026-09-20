import type { RouteDraft, RouteEntry, RouteFeaturePins } from './route-model.js';
import { routeTokensFromText } from './route-text.js';

let entrySequence = 0;
const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** IDs are local editing identities, including on HTTP development origins. */
export function createRouteEntry(text: string, pinnedFeatureId?: string,
  id: string = globalThis.crypto?.randomUUID?.() ?? `${sessionId}-${++entrySequence}`): RouteEntry {
  return { id, text, ...(pinnedFeatureId ? { pinnedFeatureId } : {}) };
}

export function routeEntriesFromText(input: string, pins: RouteFeaturePins = {},
  id?: (index: number) => string): RouteEntry[] {
  return routeTokensFromText(input).map((text, index) => createRouteEntry(text, pins[index], id?.(index)));
}
export function routeDraftFromText(input: string, pins?: RouteFeaturePins): RouteDraft {
  return { entries: routeEntriesFromText(input, pins) };
}
export function routeDraftText(draft: RouteDraft): string { return draft.entries.map(entry => entry.text).join(' '); }
/** Boundary adapter for published airport-pair lookup and legacy import APIs. */
export function routeEntryPins(entries: readonly RouteEntry[]): RouteFeaturePins {
  return Object.fromEntries(entries.flatMap((entry, index) => entry.pinnedFeatureId ? [[index, entry.pinnedFeatureId]] : []));
}
