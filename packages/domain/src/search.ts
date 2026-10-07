import type {
  FeatureCollectionResponse,
  GeoPointFeature,
  SearchResult,
} from '@zlayer/contracts';
import { featureIdent, featureIdentifiers } from './features.js';

export function searchNavigation(
  collections: FeatureCollectionResponse[],
  query: string,
  limit = 10,
): SearchResult[] {
  const normalized = query.trim().toUpperCase();
  const capacity = Math.max(0, Math.trunc(limit));
  if (normalized.length < 2 || !(capacity > 0)) return [];
  type Ranked = SearchResult & { order: number };
  const compare = (a: Ranked, b: Ranked) => b.score - a.score ||
    featureIdent(a.feature).localeCompare(featureIdent(b.feature)) || a.order - b.order;
  // Worst retained result at the root: O(limit) live candidates and O(log limit)
  // admission. Source order explicitly preserves stable ties across editions.
  const best: Ranked[] = [];
  let order = 0;
  for (const collection of collections) for (const feature of collection.features) {
    const position = order++, score = scoreFeature(feature, normalized);
    if (score <= 0) continue;
    const candidate = { feature, layer: collection.meta.layer, score, order: position };
    if (best.length < capacity) {
      let i = best.push(candidate) - 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (compare(best[parent]!, best[i]!) >= 0) break;
        [best[parent], best[i]] = [best[i]!, best[parent]!]; i = parent;
      }
    } else if (compare(candidate, best[0]!) < 0) {
      best[0] = candidate;
      let i = 0;
      while (2 * i + 1 < best.length) {
        let child = 2 * i + 1;
        if (child + 1 < best.length && compare(best[child + 1]!, best[child]!) > 0) child++;
        if (compare(best[i]!, best[child]!) >= 0) break;
        [best[i], best[child]] = [best[child]!, best[i]!]; i = child;
      }
    }
  }
  return best.sort(compare).map(({ order: _order, ...result }) => result);
}

function scoreFeature(feature: GeoPointFeature, query: string): number {
  const identifiers = featureIdentifiers(feature);
  const name = String(feature.properties.name ?? '').toUpperCase();

  if (identifiers.includes(query)) return 100;
  if (identifiers.some((identifier) => identifier.startsWith(query))) return 80;
  if (name === query) return 70;
  if (name.startsWith(query)) return 55;
  if (name.includes(query)) return 30;
  return 0;
}
