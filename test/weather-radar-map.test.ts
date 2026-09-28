import assert from 'node:assert/strict';
import test from 'node:test';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { RadarContours, RadarFile } from '@zlayer/contracts';
import { mountRadarMap } from '../src/layers/weather-awc/radar/map';
import type { WeatherController, WeatherState } from '../src/layers/weather-awc/controller';
import { weatherAwcPreferences } from '../src/layers/weather-awc/preferences';
import { withAbort } from '../src/core/data/abort';
import { radarFixture } from './fixtures/radar';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const NATIONAL = 'weather-awc-radar', TERMINALS = `${NATIONAL}-terminals`;

for (const pending of ['acquisition', 'submission']) test(`terminal changes preserve national radar pending ${pending}`, async t => {
  const fixture = radarFixture(Date.now(), true);
  const state: Pick<WeatherState, 'preferences' | 'radar' | 'radarRetry' | 'radarDisplay' | 'selectedTime' | 'now'> = {
    preferences: weatherAwcPreferences.select({ awcEnabled: true, awcRadar: true }),
    radar: { snapshot: fixture.catalog, loading: false }, radarRetry: 0, radarDisplay: { loading: false, sites: [] },
    selectedTime: null, now: fixture.catalog.checkedAt,
  };
  const loads: { file: RadarFile; signal: AbortSignal; resolve(): void }[] = [];
  const writes: { source: string; resolve(): void }[] = [];
  const sources = new Map<string, { setData(): Promise<void> }>();
  const layers = new Map<string, { id: string; layout: { visibility: string } }>();
  const errors = new Set<(event: { sourceId: string; error: Error }) => void>();
  let zoom = 6;
  const map = {
    getBounds: () => ({ getWest: () => -124, getEast: () => -121, getSouth: () => 36, getNorth: () => 39 }), getZoom: () => zoom,
    getSource: (id: string) => sources.get(id), getLayer: (id: string) => layers.get(id),
    addSource(id: string) { sources.set(id, { setData: () => new Promise<void>(resolve => writes.push({ source: id, resolve })) }); },
    removeSource(id: string) { sources.delete(id); },
    addLayer(layer: { id: string; layout: { visibility: string } }) { layers.set(layer.id, layer); },
    removeLayer(id: string) { layers.delete(id); },
    setLayoutProperty(id: string, _property: string, value: string) { layers.get(id)!.layout.visibility = value; },
    on(event: string, listener: (event: { sourceId: string; error: Error }) => void) { if (event === 'error') errors.add(listener); },
    off(event: string, listener: (event: { sourceId: string; error: Error }) => void) { if (event === 'error') errors.delete(listener); },
  } as unknown as MapLibreMap;
  const controller = {
    getSnapshot: () => state,
    setRadarDisplay(display: WeatherState['radarDisplay']) { state.radarDisplay = display; },
    loadRadar(file: RadarFile, signal: AbortSignal) {
      return withAbort(new Promise<RadarContours>(resolve => loads.push({ file, signal,
        resolve: () => resolve(JSON.parse(fixture.files.get(file.path)!.toString()) as RadarContours) })), signal);
    },
  } as unknown as WeatherController;
  const renderer = mountRadarMap(map, controller, () => 'weather'); t.after(() => renderer.destroy());
  renderer.update();
  if (pending === 'submission') { loads[0]!.resolve(); await flush(); }
  zoom = 7; renderer.update(); await flush();
  assert.equal(loads.filter(load => load.file.site === 'CONUS').length, 1);
  assert.equal(loads[0]!.signal.aborted, false, 'entering terminal coverage preserves national acquisition');
  if (pending === 'acquisition') { loads[0]!.resolve(); await flush(); }
  assert.equal(writes.filter(write => write.source === NATIONAL).length, 1, 'national geometry is indexed once');
  writes.find(write => write.source === NATIONAL)!.resolve(); await flush();
  assert.deepEqual(state.radarDisplay.sites, ['CONUS'], 'national source commits while terminal acquisition is pending');
  assert.equal(state.radarDisplay.loading, true);

  zoom = 6; renderer.update(); await flush();
  assert.equal(loads[1]!.signal.aborted, true, 'leaving a terminal cancels only its task');
  loads[1]!.resolve(); await flush();
  assert.equal(writes.filter(write => write.source === TERMINALS).length, 0);
  assert.deepEqual(state.radarDisplay.sites, ['CONUS']);
  zoom = 7; renderer.update(); loads[2]!.resolve(); await flush();
  writes.find(write => write.source === TERMINALS)!.resolve(); await flush();
  assert.deepEqual(state.radarDisplay.sites, ['CONUS', 'TOKC']);
  const terminalSource = sources.get(TERMINALS), nationalSource = sources.get(NATIONAL);
  for (const listener of errors) listener({ sourceId: NATIONAL, error: new Error('Worker failed') });
  assert.deepEqual(state.radarDisplay.sites, []);
  assert.ok([...layers.values()].every(layer => layer.layout.visibility === 'none'));
  state.radarRetry++; renderer.update(); await flush();
  assert.notEqual(sources.get(NATIONAL), nationalSource, 'retry recreates the failed source');
  assert.equal(sources.get(TERMINALS), terminalSource, 'retry preserves the healthy terminal source');
  assert.equal(writes.filter(write => write.source === TERMINALS).length, 1);
  writes.at(-1)!.resolve(); await flush();
  assert.deepEqual(state.radarDisplay.sites, ['CONUS', 'TOKC']);

  state.selectedTime = fixture.catalog.history!.find(file => file.site === 'CONUS')!.observedAt;
  renderer.update(); await flush();
  assert.deepEqual(state.radarDisplay.sites, [], 'a different observation clears the old display immediately');
  state.preferences = { ...state.preferences, awcRadar: false }; renderer.update();
  for (const load of loads) load.resolve();
  await flush();
  assert.equal(sources.size, 0); assert.equal(layers.size, 0);
  assert.deepEqual(state.radarDisplay, { loading: false, sites: [] });
});
