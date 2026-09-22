import { pluginStorage } from './storage';
import { isRecord } from '@zlayer/contracts';
import { routeDraftFromText, routeTokensFromText } from '@zlayer/domain';
import { parseRouteEntries } from './draft-storage';
import { EMPTY_ROUTE_DRAFT, type RouteDraft } from './draft';

export const routeDraftRecord = pluginStorage.record('draft', { version: 2, fallback: EMPTY_ROUTE_DRAFT,
  legacyKey: 'zlayer-route-draft-v1', decode: decodeDraft,
  encode: draft => ({ version: 2, entries: draft.entries }),
});
function decodeDraft(value: unknown): RouteDraft | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version === 1 && typeof value.input === 'string') {
    const count = routeTokensFromText(value.input).length;
    const pins = isRecord(value.pinnedFeatureIds) ? value.pinnedFeatureIds : {};
    return routeDraftFromText(value.input, Object.fromEntries(Object.entries(pins).flatMap(([index, id]) =>
      /^(0|[1-9]\d*)$/.test(index) && Number(index) < count && typeof id === 'string' && id.length > 0 ? [[index, id]] : [])));
  }
  if (value.version !== 2 || !Array.isArray(value.entries)) return undefined;
  return parseRouteEntries(value.entries);
}
