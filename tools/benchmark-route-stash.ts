import { performance } from 'node:perf_hooks';
import { routeDraftFromText } from '@zlayer/domain';
import type { GeoPointFeature, NavigationData } from '@zlayer/contracts';
import { createRecommendationModel } from '../src/layers/routes/suggestions';

// Synthetic lookup comparison, not a timing assertion or device certification.
// Run from the repository root: node --import=tsx tools/benchmark-route-stash.ts
const airports: GeoPointFeature[] = Array.from({ length: 20_000 }, (_, index) => ({
  type: 'Feature', id: `airport:${index}`, geometry: { type: 'Point', coordinates: [-120 + index / 100_000, 35] },
  properties: { faaId: `A${index}`, icaoId: `KA${index}`, ident: `KA${index}` },
}));
const navigation: NavigationData = { airports: { type: 'FeatureCollection', features: airports,
  meta: { layer: 'airports', revision: '2026-09-03', returned: airports.length, truncated: false } } };
const pair = { origin: airports[0]!, destination: airports[1]! };
// The active route normally already owns the shared navigation resolver.
createRecommendationModel(undefined, undefined, pair, navigation);
for (const size of [25, 100, 1_000, 10_000]) {
  const stash = Array.from({ length: size }, (_, index) => ({ id: `save:${index}`, name: `Save ${index}`,
    draft: routeDraftFromText(index === 0 ? 'KA0 KA1' : `KA${index + 2} KA${index + 3}`) }));
  const run = () => {
    const start = performance.now();
    const model = createRecommendationModel(undefined, undefined, pair, navigation, undefined, undefined, stash);
    if (model.groups.stash.length !== 1) throw new Error('Lookup returned incorrect matches');
    return performance.now() - start;
  };
  const firstMs = run();
  const samples = Array.from({ length: 7 }, run).sort((a, b) => a - b);
  console.log(JSON.stringify({ airports: airports.length, savedRoutes: size,
    firstMs: Number(firstMs.toFixed(3)), medianRefreshMs: Number(samples[3]!.toFixed(3)) }));
}
