import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceReadContext } from '../src/workspace/read-context';
import { startupStepBlocking, weatherStartupWork, workspaceStartupSteps } from '../src/workspace/startup';
import { createWeatherController, forecastPreparation, forecastStreams } from '../src/layers/weather-awc/controller';
import { weatherAwcPreferences } from '../src/layers/weather-awc/preferences';
import { advisorySnapshot } from './fixtures/awc-advisories';
import { gridFixture } from './fixtures/awc-grids';

function input(): Parameters<typeof workspaceStartupSteps>[0] {
  return {
    context: createWorkspaceReadContext({ schemaVersion: 1, revision: '2026-09-03', generatedAt: '2026-09-03T00:00:00Z',
      charts: [], navigation: [], weather: [] }, []), mapIdle: true,
    plugins: ['navigation', 'terrain', 'obstructions', 'metar', 'weather-awc'].map(id => ({ id, title: `Registered ${id}`, enabled: true, status: 'ready' })),
    navigation: { enabled: true, visibility: { airports: true, 'vfr-waypoints': false, navaids: false, fixes: false },
      loadState: { airports: 'ready' }, loading: false, issues: [], airways: undefined },
    routes: { enabled: true, hasEntries: false, status: 'idle' }, plates: { enabled: true, snapshot: {} },
    charts: { count: 0, state: 'ready' }, terrain: { enabled: true, state: 'idle' }, obstructions: { enabled: true, state: 'zoom' },
    metar: { snapshot: { state: { status: 'idle' } }, reports: [] }, awc: undefined,
  };
}

test('startup uses registered names, omits undemanded data, and tracks terrain once loading is requested', () => {
  const state = input();
  assert.deepEqual(workspaceStartupSteps(state).map(step => step.label), ['Workspace', 'Registered navigation', 'Map']);
  state.terrain.state = 'loading';
  assert.equal(workspaceStartupSteps(state).find(step => step.id === 'terrain')?.state, 'loading');
  state.terrain.state = 'error';
  assert.equal(workspaceStartupSteps(state).find(step => step.id === 'terrain')?.state, 'unavailable');
  state.plugins = state.plugins.map(plugin => ({ ...plugin, enabled: false }));
  assert.deepEqual(workspaceStartupSteps(state).map(step => step.id), ['workspace', 'map']);
});

test('all plugin activation failures are visible, but optional report loading does not block entry', () => {
  const state = input();
  state.plugins = [...state.plugins, { id: 'another-plugin', title: 'Another plugin', enabled: true, status: 'failed' }];
  state.metar.reports = ['loading'];
  state.awc = { state: 'loading', blocking: false, detail: 'Preparing forecasts · 2/18' };
  const steps = workspaceStartupSteps(state);
  assert.equal(steps.find(step => step.id === 'another-plugin')?.state, 'unavailable');
  assert.equal(steps.find(step => step.id === 'metar')?.state, 'loading');
  assert.equal(steps.find(step => step.id === 'weather-awc')?.detail, 'Preparing forecasts · 2/18');
  assert.equal(steps.some(startupStepBlocking), false);
  state.navigation.loading = true;
  assert.equal(workspaceStartupSteps(state).some(startupStepBlocking), true);
  state.metar.reports = ['cached', 'unavailable'];
  assert.equal(workspaceStartupSteps(state).find(step => step.id === 'metar')?.state, 'limited');
});

test('weather startup distinguishes requested work, offline absence, cached data, preparation and failed frames', () => {
  const controller = createWeatherController({ restore: () => ({ loading: false }), refresh: async product => advisorySnapshot(product) });
  const initial = controller.getSnapshot();
  assert.equal(weatherStartupWork(initial, true), undefined);
  const state = { ...initial, preferences: weatherAwcPreferences.select({ awcEnabled: true }) };
  assert.equal(weatherStartupWork(state, true)?.state, 'loading');
  assert.equal(weatherStartupWork(state, false)?.state, 'unavailable');
  for (const product of ['gairmet', 'sigmet', 'cwa'] as const) state.products[product] = { loading: false, snapshot: advisorySnapshot(product) };
  assert.equal(weatherStartupWork(state, false)?.state, 'cached');
  state.preferences.awcGridMode = 'cloudCover';
  state.grid = { ...state.grid, loading: true, preparation: { ready: 2, total: 18, failed: 0 } };
  assert.equal(weatherStartupWork(state, true)?.detail, 'Preparing forecasts · 2/18');
  state.grid.preparation!.failed = 1;
  assert.equal(weatherStartupWork(state, true)?.state, 'limited');
  assert.equal(weatherStartupWork(state, true)?.detail, undefined);
  state.grid.preparation = { ready: 18, total: 18, failed: 0 };
  assert.equal(weatherStartupWork(state, true)?.detail, undefined);
});

test('wind-only startup and shared preparation account for pressure-level guidance and restored data', () => {
  const controller = createWeatherController({ restore: () => ({ loading: false }), refresh: async product => advisorySnapshot(product) });
  const state = { ...controller.getSnapshot(), preferences: weatherAwcPreferences.select({ awcEnabled: true,
    awcGairmet: false, awcSigmet: false, awcConvective: false, awcCwa: false, awcWindBarbs: true }) };
  assert.equal(weatherStartupWork(state, true)?.state, 'loading');
  state.wind.loading = true;
  assert.equal(weatherStartupWork(state, true)?.detail, undefined, 'selected wind loading has no full-timeline count');
  state.preferences.awcGridMode = 'cloudCover';
  state.grid.preparation = { ready: 18, total: 18, failed: 0 };
  assert.deepEqual(forecastPreparation(state), { ready: 18, total: 18, failed: 0, limited: false });
  assert.equal(weatherStartupWork(state, true)?.state, 'loading', 'a complete cloud timeline cannot hide pending wind loading');
  state.wind.preparation = { ready: 0, total: 0, failed: 0 };
  assert.deepEqual(forecastPreparation(state), { ready: 18, total: 18, failed: 0, limited: false }, 'wind discovery preserves completed cloud saves');
  assert.equal(weatherStartupWork(state, true)?.state, 'loading', 'unknown wind work is still pending');
  state.preferences.awcGridMode = 'none';
  const manifest = gridFixture('winds').manifest;
  const data = { manifest, frame: manifest.frames[0]!, values: new Float32Array(), byteLength: 0 };
  state.wind = { products: { ...state.wind.products, winds: { manifest, loading: false } }, data, loading: false };
  state.windDisplay = data;
  assert.equal(weatherStartupWork(state, true)?.state, 'cached');
  state.wind.products.winds.checkedAt = Date.now();
  assert.equal(weatherStartupWork(state, true)?.state, 'ready');
  state.wind.products.winds.storageError = 'Forecast metadata could not be saved';
  assert.equal(weatherStartupWork(state, true)?.state, 'limited');
  assert.equal(weatherStartupWork(state, true)?.blocking, false);
});

test('temperature and barbs share preparation but wait for both requested displays, ignoring inactive errors', () => {
  const controller = createWeatherController({ restore: () => ({ loading: false }), refresh: async product => advisorySnapshot(product) });
  const state = { ...controller.getSnapshot(), preferences: weatherAwcPreferences.select({ awcEnabled: true,
    awcGairmet: false, awcSigmet: false, awcConvective: false, awcCwa: false, awcWindBarbs: true, awcGridMode: 'temperature' }) };
  const manifest = gridFixture('winds').manifest;
  const data = { manifest, frame: manifest.frames[0]!, values: new Float32Array(), byteLength: 0 };
  state.wind = { ...state.wind, data, preparation: { ready: 3, total: 3, failed: 0 },
    products: { ...state.wind.products, winds: { manifest, loading: false, checkedAt: Date.now() } } };
  state.windDisplay = data;
  assert.equal(forecastStreams(state).length, 1, 'temperature and barbs never double-count the shared bundle');
  assert.deepEqual(forecastPreparation(state), { ready: 3, total: 3, failed: 0, limited: false });
  assert.equal(weatherStartupWork(state, true)?.state, 'rendering', 'ready barbs cannot hide pending temperature');
  state.gridDisplay = { data, mode: 'temperature', sld: false };
  assert.equal(weatherStartupWork(state, true)?.state, 'ready');
  state.windDisplay = undefined;
  assert.equal(weatherStartupWork(state, true)?.state, 'rendering', 'ready temperature cannot hide pending barbs');
  state.windRenderError = 'Barbs failed';
  assert.equal(weatherStartupWork(state, true)?.state, 'limited');
  state.preferences.awcWindBarbs = false;
  assert.equal(forecastStreams(state)[0]!.error, undefined, 'disabled renderer errors do not leak into temperature');
  assert.equal(weatherStartupWork(state, true)?.state, 'ready');
  state.preferences.awcGridMode = 'none';
  assert.deepEqual(forecastStreams(state), []);
  assert.equal(forecastPreparation(state), undefined);
});
