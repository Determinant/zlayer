import { Map, setWorkerUrl, type ImageSource } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { MapLayerHost, WEATHER_LAYER_ANCHOR } from '../../src/core/map/layer';
import { createWeatherMap } from '../../src/layers/weather-awc/map';
import { createWeatherController } from '../../src/layers/weather-awc/controller';
import { weatherAwcPreferences, type WeatherAwcPreferences } from '../../src/layers/weather-awc/preferences';
import { GridClient } from '../../src/layers/weather-awc/grids/client';
import { gridCell, gridValue } from '../../src/layers/weather-awc/grids/format';
import { WeatherTimeline } from '../../src/layers/weather-awc/timeline';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import 'maplibre-gl/dist/maplibre-gl.css';

setWorkerUrl(workerUrl);
const native = new URLSearchParams(location.search).has('native');
const controller = createWeatherController({ advisories: { restore: () => ({ loading: false }),
  refresh: async () => { throw new Error('Advisories are disabled in this fixture'); },
},
    grids: new GridClient(new URL('/api/weather/grids/', location.href).href, native) });
let preferences = weatherAwcPreferences.select({ awcEnabled: true, awcGridMode: 'cloudCover',
  awcGairmet: false, awcSigmet: false, awcConvective: false, awcCwa: false });
const change = (patch: Partial<WeatherAwcPreferences>) => {
  preferences = { ...preferences, ...patch }; controller.configure({ ...preferences, change });
};
change({});
if (native) {
  const timeline = document.createElement('div');
  timeline.style.cssText = 'position:absolute;z-index:1;top:0;left:0;width:300px;background:white';
  document.body.append(timeline);
  createRoot(timeline).render(createElement(WeatherTimeline, { controller }));
}
const map = new Map({ container: 'map', center: [-100, 38], zoom: 7, fadeDuration: 0,
  attributionControl: false, canvasContextAttributes: { preserveDrawingBuffer: true },
  style: { version: 8, sources: {}, layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#ffffff' } },
    { id: WEATHER_LAYER_ANCHOR, type: 'background', paint: { 'background-opacity': 0 } },
  ] } });
const errors: string[] = [];
map.on('error', event => errors.push(event.error.message));
const host = new MapLayerHost(map, (_id, error) => errors.push(String(error)));
map.once('load', () => host.mount([createWeatherMap(controller)]));
const fixture = { map, controller, errors, recording: false, samples: [] as number[][], textureUploads: 0,
  value() {
    const shown = controller.getSnapshot().gridDisplay;
    return shown && gridValue(shown.data, shown.mode, gridCell(shown.data.manifest, -100, 38)!);
  },
  pixel(x = .5, y = .5) {
    const canvas = map.getCanvas(), gl = canvas.getContext('webgl2')!, pixel = new Uint8Array(4);
    gl.readPixels(Math.floor(canvas.width * x), Math.floor(canvas.height * y), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    return [...pixel];
  },
};
const gl = map.getCanvas().getContext('webgl2')!, upload = gl.texSubImage2D;
gl.texSubImage2D = function (...args: unknown[]) {
  const source = map.getSource('weather-awc-grid') as ImageSource | undefined;
  if (source?.image && args[args.length - 1] === source.image) fixture.textureUploads++;
  Reflect.apply(upload, this, args);
};
map.on('render', () => {
  if (fixture.recording) for (const [x, y] of [[.5, .5], [.1, .1], [.1, .9], [.9, .1], [.9, .9]]) fixture.samples.push(fixture.pixel(x, y));
});
declare global { interface Window { weatherGridFixture: typeof fixture } }
window.weatherGridFixture = fixture;
window.addEventListener('pagehide', () => { host.unmount(); map.remove(); }, { once: true });
