import assert from 'node:assert/strict';
import test from 'node:test';
import type { MapGeoJSONFeature } from 'maplibre-gl';

import { visibleMetarStationIds } from '../src/layers/metar-taf/metar/visible-stations.js';
import { AIRPORT_POINT_LAYER_IDS } from '../src/layers/navigation/definitions.js';

test('requests only rendered airport circles and deduplicates tile/world copies', () => {
  const ids = visibleMetarStationIds({
    getLayer: () => ({ id: 'test', type: 'circle', source: 'nav-airports' } as unknown as NonNullable<ReturnType<Parameters<typeof visibleMetarStationIds>[0]['getLayer']>>),
    queryRenderedFeatures: (options) => {
      assert.deepEqual(options, { layers: [...AIRPORT_POINT_LAYER_IDS, 'airports-weather-points'] });
      return [
        { properties: { icaoId: ' ksfo ' } },
        { properties: { icaoId: 'KSFO' } },
        { properties: { icaoId: 'KHWD' } },
        { properties: { faaId: 'ABC' } },
      ] as unknown as MapGeoJSONFeature[];
    },
  });
  assert.deepEqual(ids, ['KHWD', 'KSFO']);
});

test('waits for airport layers to be installed before querying the map', () => {
  assert.deepEqual(visibleMetarStationIds({
    getLayer: () => undefined,
    queryRenderedFeatures: () => { throw new Error('Layers have not loaded'); },
  }), []);
});
