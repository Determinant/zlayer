import { Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { MapLayerHost, WEATHER_LAYER_ANCHOR } from '../../src/core/map/layer';
import { createWeatherController } from '../../src/layers/weather-awc/controller';
import { AdvisoryClient } from '../../src/layers/weather-awc/client';
import { createWeatherMap } from '../../src/layers/weather-awc/map';
import { RadarClient } from '../../src/layers/weather-awc/radar/client';
import { ProgsClient } from '../../src/layers/weather-awc/progs/client';
import { weatherAwcPreferences, type WeatherAwcPreferences } from '../../src/layers/weather-awc/preferences';
import { SURFACE_LAYERS } from '../../src/layers/weather-awc/progs/map';
import 'maplibre-gl/dist/maplibre-gl.css';

setWorkerUrl(workerUrl);
const style = () => ({ version: 8 as const, glyphs: '/fonts/{fontstack}/{range}.pbf', sources: {},
  layers: [{ id: 'background', type: 'background' as const, paint: { 'background-color': '#e4e9df' } },
    { id: WEATHER_LAYER_ANCHOR, type: 'background' as const, paint: { 'background-opacity': 0 } }] });
const map = new MapLibreMap({ container: 'map', center: [-122, 37.3], zoom: 6.7, fadeDuration: 0, attributionControl: false, style: style() });
const errors: string[] = [];
map.on('error', event => errors.push(event.error.message));
const controller = createWeatherController(new AdvisoryClient(new URL('/api/weather/advisories/', location.href).href, true),
  undefined, new ProgsClient(new URL('/api/weather/progs/', location.href).href), new RadarClient(new URL('/api/weather/radar/', location.href).href));
let preferences = weatherAwcPreferences.select({ awcEnabled: true, awcProgs: true, awcGairmet: false, awcSigmet: false, awcConvective: false, awcCwa: false });
const change = (patch: Partial<WeatherAwcPreferences>) => { preferences = { ...preferences, ...patch }; controller.configure({ ...preferences, change }); };
change({});
const host = new MapLayerHost(map, (_id, error) => errors.push(String(error)));
const layer = createWeatherMap(controller);
map.on('load', () => host.mount([layer]));
const audit = { map, errors,
  state: controller.getSnapshot, select: controller.selectTime, change,
  features: () => map.queryRenderedFeatures(undefined, { layers: SURFACE_LAYERS.filter(id => map.getLayer(id)) }).map(f => f.properties),
  recover: () => { host.unmount(); map.once('style.load', () => host.mount([layer])); map.setStyle(style(), { diff: false }); },
};
Object.assign(window, { progsMapAudit: audit });
declare global { interface Window { progsMapAudit: typeof audit } }
window.addEventListener('pagehide', () => { host.unmount(); map.remove(); }, { once: true });
