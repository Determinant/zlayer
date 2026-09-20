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
  if (normalized.length < 2) return [];

  return collections
    .flatMap((collection) =>
      collection.features.map((feature) => ({
        feature,
        layer: collection.meta.layer,
        score: scoreFeature(feature, normalized),
      })),
    )
    .filter((result) => result.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || featureIdent(a.feature).localeCompare(featureIdent(b.feature)),
    )
    .slice(0, Math.max(0, limit));
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
