import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  FeatureCollectionResponse,
  GeoPointFeature,
  NavigationLayerId,
} from '@zlayer/contracts';

import { featureIdent, searchNavigation } from '../src/index.js';

const airport = feature('airport:02022.', 'airports', {
  faaId: 'PAO',
  icaoId: 'KPAO',
  name: 'PALO ALTO',
});
const snsAirport = feature('airport:02137.', 'airports', {
  faaId: 'SNS',
  icaoId: 'KSNS',
  name: 'SALINAS MUNI',
});
const snsNavaid = feature('navaid:US:CA:SNS:VORTAC', 'navaids', {
  ident: 'SNS',
  name: 'SALINAS',
});

test('matches both typed SNS features without collapsing identity', () => {
  const results = searchNavigation(
    [collection('airports', [snsAirport]), collection('navaids', [snsNavaid])],
    'sns',
  );
  assert.deepEqual(
    results.map((result) => result.feature.id),
    ['airport:02137.', 'navaid:US:CA:SNS:VORTAC'],
  );
});

test('ranks an exact ICAO identifier first', () => {
  const results = searchNavigation([collection('airports', [airport, snsAirport])], 'KPAO');
  assert.equal(results[0]?.feature.id, 'airport:02022.');
  assert.equal(featureIdent(results[0]!.feature), 'KPAO');
});

test('ignores one-character searches', () => {
  assert.deepEqual(searchNavigation([collection('airports', [airport])], 'K'), []);
});

test('bounded ranking preserves score, identifier and stable edition order for custom limits', () => {
  const features = Array.from({ length: 1000 }, (_, i) => feature(`edition:${i}`, 'airports', {
    ident: i % 3 ? `AB${String(i % 23).padStart(2, '0')}` : 'AB', name: i % 2 ? 'AIRPORT' : 'AB AIRPORT',
  }));
  const source = [collection('airports', features.slice(0, 500)), collection('airports', features.slice(500))];
  const reference = features.map(feature => ({ feature, layer: 'airports' as const, score: featureIdent(feature) === 'AB' ? 100 : 80 }))
    .sort((a, b) => b.score - a.score || featureIdent(a.feature).localeCompare(featureIdent(b.feature)));
  for (const limit of [-1, 0, NaN, 1, 3.5, 10, 2000, Infinity]) {
    assert.deepEqual(searchNavigation(source, ' ab ', limit), reference.slice(0, Math.max(0, limit)), String(limit));
  }
});

function feature(
  id: string,
  layer: NavigationLayerId,
  properties: GeoPointFeature['properties'],
): GeoPointFeature {
  return {
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: [-122, 37] },
    properties: { ...properties, kind: layer },
  };
}

function collection(
  layer: NavigationLayerId,
  features: GeoPointFeature[],
): FeatureCollectionResponse {
  return {
    type: 'FeatureCollection',
    features,
    meta: { revision: '2026-09-03', layer, returned: features.length, truncated: false },
  };
}
