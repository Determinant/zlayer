import { useStoredState } from '../../core/ui/use-persistent-state';
import { isRecord } from '@zlayer/contracts';
import { routeDraftFromText, routeTokensFromText } from '@zlayer/domain';
import { parseRouteEntries } from './draft-storage';
import { EMPTY_ROUTE_DRAFT, type RouteDraft } from './draft';

// Keep the storage slot so existing installations migrate once, in place.
const key = 'zlayer-route-draft-v1';
export function useRouteDraft() {
  return useStoredState(key, readDraft, saveDraft);
}
function saveDraft(draft: RouteDraft): void {
  try { localStorage.setItem(key, JSON.stringify({ version: 2, entries: draft.entries })); }
  catch { /* Full or denied storage must not disable route editing. */ }
}
function readDraft(): RouteDraft {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!isRecord(value)) return EMPTY_ROUTE_DRAFT;
    if (value.version === 1 && typeof value.input === 'string') {
      const count = routeTokensFromText(value.input).length;
      const pins = isRecord(value.pinnedFeatureIds) ? value.pinnedFeatureIds : {};
      const migrated = routeDraftFromText(value.input, Object.fromEntries(Object.entries(pins).flatMap(([index, id]) =>
        /^(0|[1-9]\d*)$/.test(index) && Number(index) < count && typeof id === 'string' && id.length > 0 ? [[index, id]] : [])));
      // Commit this known migration once so generated entry IDs survive reload.
      saveDraft(migrated);
      return migrated;
    }
    if (value.version !== 2 || !Array.isArray(value.entries)) return EMPTY_ROUTE_DRAFT;
    return parseRouteEntries(value.entries) ?? EMPTY_ROUTE_DRAFT;
  } catch { return EMPTY_ROUTE_DRAFT; }
}
