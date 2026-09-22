import { isRecord } from '@zlayer/contracts';
import { createRouteEntry, routeTokensFromText, type RouteDraft, type RouteEntry } from '@zlayer/domain';
import { parseRouteEntries } from './draft-storage';
import { pluginStorage } from './storage';

const stashSlot = pluginStorage.slot('stash', 'zlayer-route-stash-v1');
export const ROUTE_STASH_KEY = stashSlot.key;
export const ROUTE_STASH_CHANGED = 'zlayer-route-stash-changed';
export type SavedRoute = { id: string; name: string; draft: RouteDraft };
type StashStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function readRouteStash(storage?: StashStorage): SavedRoute[] {
  let raw: string | null;
  try { raw = stashSlot.read(storage); }
  catch { throw new Error('Route stash is unavailable. Check site storage permissions and try again.'); }
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.routes)) throw new Error();
    const ids = new Set<string>();
    return value.routes.map((route: unknown) => {
      if (!isRecord(route) || typeof route.id !== 'string' || !route.id || ids.has(route.id) ||
        typeof route.name !== 'string' || !isRecord(route.draft)) throw new Error();
      const draft = parseRouteEntries(route.draft.entries);
      if (!draft?.entries.length) throw new Error();
      ids.add(route.id);
      return { id: route.id, name: route.name.trim(), draft };
    });
  } catch { throw new Error('Saved routes could not be read. Existing saves have been left untouched.'); }
}

/** Serialize the complete read/change/write across windows, not just setItem. */
export async function updateRouteStash(change: (routes: SavedRoute[]) => SavedRoute[]): Promise<SavedRoute[]> {
  if (!navigator.locks) throw new Error('Saving routes safely requires browser window coordination. Update your browser and retry.');
  return navigator.locks.request(ROUTE_STASH_KEY, { ifAvailable: true }, lock => {
    if (!lock) throw new Error('Another window is saving routes. Try again in a moment.');
    const routes = changeRouteStash(change);
    window.dispatchEvent(new Event(ROUTE_STASH_CHANGED));
    return routes;
  });
}

/** Synchronous storage primitive; browser callers use updateRouteStash for coordination. */
export function changeRouteStash(change: (routes: SavedRoute[]) => SavedRoute[], storage?: StashStorage): SavedRoute[] {
  const routes = change(readRouteStash(storage));
  try { stashSlot.write(JSON.stringify({ version: 1, routes }), storage); }
  catch { throw new Error('Could not save the route stash. Check available storage and site permissions, then try again.'); }
  return routes;
}

export function savedRoute(name: string, draft: RouteDraft): SavedRoute {
  if (!draft.entries.length) throw new Error('Enter a route before saving.');
  return { id: globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    name: name.trim(), draft: structuredClone(draft) };
}

/** Retain pins and procedure attachments on unchanged entries when editing filing text. */
export function editSavedDraft(draft: RouteDraft, text: string): RouteDraft {
  const tokens = routeTokensFromText(text), old = draft.entries;
  if (!tokens.length) throw new Error('Enter at least one route waypoint.');
  const matches = Array.from({ length: old.length + 1 }, () => new Uint32Array(tokens.length + 1));
  for (let i = old.length - 1; i >= 0; i--) for (let j = tokens.length - 1; j >= 0; j--) {
    matches[i]![j] = old[i]!.text === tokens[j] ? 1 + matches[i + 1]![j + 1]!
      : Math.max(matches[i + 1]![j]!, matches[i]![j + 1]!);
  }
  const entries: RouteEntry[] = [];
  let i = 0, j = 0;
  while (j < tokens.length) {
    if (i < old.length && old[i]!.text === tokens[j]) { entries.push(old[i++]!); j++; }
    else if (i < old.length && matches[i + 1]![j]! > matches[i]![j + 1]!) i++;
    else entries.push(createRouteEntry(tokens[j++]!));
  }
  return { entries };
}
