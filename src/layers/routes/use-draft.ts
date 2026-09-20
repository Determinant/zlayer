import { useEffect, useState } from 'react';
import { isRecord } from '@zlayer/contracts';
import { routeDraftFromText, routeTokensFromText, type RouteEntry } from '@zlayer/domain';
import { EMPTY_ROUTE_DRAFT, type RouteDraft } from './draft';

// Keep the storage slot so existing installations migrate once, in place.
const key = 'zlayer-route-draft-v1';
export function useRouteDraft() {
  const [draft, setDraft] = useState(readDraft);
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify({ version: 2, entries: draft.entries })); }
    catch { /* Full or denied storage must not disable route editing. */ }
  }, [draft]);
  return [draft, setDraft] as const;
}
function readDraft(): RouteDraft {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!isRecord(value)) return EMPTY_ROUTE_DRAFT;
    if (value.version === 1 && typeof value.input === 'string') {
      const count = routeTokensFromText(value.input).length;
      const pins = isRecord(value.pinnedFeatureIds) ? value.pinnedFeatureIds : {};
      return routeDraftFromText(value.input, Object.fromEntries(Object.entries(pins).flatMap(([index, id]) =>
        /^(0|[1-9]\d*)$/.test(index) && Number(index) < count && typeof id === 'string' && id.length > 0 ? [[index, id]] : [])));
    }
    if (value.version !== 2 || !Array.isArray(value.entries)) return EMPTY_ROUTE_DRAFT;
    const ids = new Set<string>();
    const entries: RouteEntry[] = [];
    for (const entry of value.entries) {
      if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id) ||
        typeof entry.text !== 'string' || routeTokensFromText(entry.text).length !== 1 ||
        routeTokensFromText(entry.text)[0] !== entry.text) return EMPTY_ROUTE_DRAFT;
      ids.add(entry.id);
      entries.push({ id: entry.id, text: entry.text,
        ...(typeof entry.pinnedFeatureId === 'string' && entry.pinnedFeatureId ? { pinnedFeatureId: entry.pinnedFeatureId } : {}) });
    }
    return { entries };
  } catch { return EMPTY_ROUTE_DRAFT; }
}
