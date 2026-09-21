import { Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { FeatureCollectionResponse } from '@zlayer/contracts';
import { MapLayerHost } from '../../src/core/map/layer';
import { createNavigationLayer } from '../../src/layers/navigation/layer';
import { DEFAULT_VISIBILITY } from '../../src/layers/navigation/definitions';
import { createMetarLayer } from '../../src/layers/metar-taf/metar/layer';
import { MetarClient } from '../../src/layers/metar-taf/metar/client';
import 'maplibre-gl/dist/maplibre-gl.css';

setWorkerUrl(workerUrl);
const airports: FeatureCollectionResponse = { type: 'FeatureCollection',
  meta: { revision: 'test', layer: 'airports', returned: 2, truncated: false },
  features: ['KAAA', 'KBBB'].map((icaoId, index) => ({ type: 'Feature', id: icaoId,
    geometry: { type: 'Point', coordinates: [-122 + index * 10, 37] },
    properties: { kind: 'airport', facilityType: 'A', use: 'PU', towered: true, icaoId, ident: icaoId },
  })),
};
const map = new MapLibreMap({ container: 'map', center: [-122, 37], zoom: 8, fadeDuration: 0,
  attributionControl: false, style: { version: 8, glyphs: '/fonts/{fontstack}/{range}.pbf', sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#314653' } }] } });
const errors: string[] = [];
map.on('error', event => errors.push(event.error.message));
const navigation = createNavigationLayer();
const weather = createMetarLayer(new MetarClient(new URL('/weather-map-test', location.href)));
const host = new MapLayerHost(map, (_id, error) => errors.push(String(error)));
let loaded = false, enabled = true, visible = true, queries = 0;
const query = map.queryRenderedFeatures.bind(map);
map.queryRenderedFeatures = (...args) => { queries++; return query(...args); };
const update = () => {
  host.update(navigation, { data: loaded ? { airports } : {}, visibility: { ...DEFAULT_VISIBILITY, airports: visible } });
  host.update(weather.map, { airports: loaded ? airports : undefined, enabled, airportsVisible: visible });
};
update();
map.on('load', () => host.mount([navigation, weather.map]));
Object.assign(window, { weatherMapAudit: {
  map, errors, queries: () => queries,
  stations: () => weather.getSnapshot().visibleStationIds,
  loadAirports() { loaded = true; update(); },
  setVisibility(value: boolean) { visible = value; update(); },
  setEnabled(value: boolean) { enabled = value; update(); },
} });
window.addEventListener('pagehide', () => { host.unmount(); map.remove(); }, { once: true });
