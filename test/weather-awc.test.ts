import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { isAwcAdvisorySnapshot, isWeatherGeometry, type AwcAdvisoryProduct, type SurfaceSnapshot } from '@zlayer/contracts';
import { advisorySnapshot, advisorySource, WEATHER_NOW } from './fixtures/awc-advisories';
import cwaNullHazard from './fixtures/awc-cwa-null-hazard.json';
import { advisoryHazard, FORECAST_HOURS, isSourceCollection, normalizeAdvisories } from '../src/layers/weather-awc/source';
import { advisoryFrame, forecastStops, currentFrame, HOUR } from '../src/layers/weather-awc/time';
import { AdvisoryClient } from '../src/layers/weather-awc/client';
import { noaaAdvisoryUrl } from '../src/layers/weather-awc/advisory-endpoints';
import { pluginStorage as weatherStorage } from '../src/layers/weather-awc/storage';
import { GridClient } from '../src/layers/weather-awc/grids/client';
import { gridFixture } from './fixtures/awc-grids';
import { createWeatherController, forecastPreparation } from '../src/layers/weather-awc/controller';
import { weatherAwcPreferences } from '../src/layers/weather-awc/preferences';
import { requestJson, weatherCheckedAt } from '../src/core/data/fetch-json';
import { createWeatherMap, ADVISORY_LAYERS } from '../src/layers/weather-awc/map';
import { WEATHER_LAYER_ANCHOR, ROUTE_LINE_ANCHOR, MapLayerHost } from '../src/core/map/layer';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { withAbort } from '../src/core/data/abort';
import { cacheFixture } from './helpers/cache';
import type { SurfaceState } from '../src/layers/weather-awc/progs/client';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function environment(t: TestContext) {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const window = Object.assign(new EventTarget(), { localStorage: storage });
  const navigator = { onLine: true };
  for (const [key, value] of Object.entries({ window, document, navigator, localStorage: storage })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (original) Object.defineProperty(globalThis, key, original); else Reflect.deleteProperty(globalThis, key); });
  }
  return { values, window, document, navigator };
}

test('enabling winds preserves in-flight cloud saves and returning from temperature keeps their completed progress', async t => {
  const locks = navigator.locks;
  Object.assign(environment(t).navigator, { locks }); cacheFixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: WEATHER_NOW });
  const fixture = gridFixture('clouds'), client = new GridClient('https://app.test/api/weather/grids/');
  let releaseBackground!: () => void, backgroundStarted!: () => void, windStarted!: () => void;
  const background = new Promise<void>(resolve => { releaseBackground = resolve; });
  const started = new Promise<void>(resolve => { backgroundStarted = resolve; });
  const windDiscovery = new Promise<void>(resolve => { windStarted = resolve; });
  const jobs: { time: number; signal: AbortSignal }[] = [], requested: string[] = [];
  t.mock.method(client, 'restore', (product: string) => ({ loading: false, ...(product === 'clouds' ? { manifest: fixture.manifest } : {}) }));
  t.mock.method(client, 'refresh', async (product: string, signal: AbortSignal) => {
    if (product === 'clouds') return fixture.manifest;
    windStarted(); return withAbort(new Promise<never>(() => {}), signal);
  });
  const prepare = client.prepare.bind(client);
  t.mock.method(client, 'prepare', async (...args: Parameters<GridClient['prepare']>) => {
    jobs.push({ time: args[1].validTime, signal: args[2] });
    if (jobs.length === 2) backgroundStarted();
    await withAbort(background, args[2]);
    return prepare(...args);
  });
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const frame = fixture.manifest.frames.find(frame => request.url.endsWith(frame.path));
    assert.ok(frame); requested.push(frame.path);
    return new Response(Uint8Array.from(Buffer.from(fixture.files[frame.path]!, 'base64')));
  });
  const controller = createWeatherController({ restore: () => ({ loading: false }), refresh: async product => advisorySnapshot(product) }, client);
  t.after(() => controller.detach());
  let preferences = weatherAwcPreferences.select({ awcEnabled: true, awcGridMode: 'cloudCover',
    awcGairmet: false, awcSigmet: false, awcConvective: false, awcCwa: false });
  const change = (patch: Partial<typeof preferences>) => {
    preferences = { ...preferences, ...patch }; controller.configure({ ...preferences, change });
  };
  change({}); controller.attach();
  await started;
  assert.equal(controller.getSnapshot().grid.preparation?.ready, 1);
  controller.change({ awcWindBarbs: true }); await windDiscovery;
  assert.ok(jobs.every(job => !job.signal.aborted), 'wind demand must not cancel valid cloud work');
  assert.deepEqual(forecastPreparation(controller.getSnapshot()), { ready: 1, total: 3, failed: 0, limited: false });
  controller.setForecastInteraction('controls', true);
  assert.ok(jobs.every(job => !job.signal.aborted), 'a short interaction pauses new starts without discarding current downloads');
  const completed = new Promise<void>(resolve => {
    const unsubscribe = controller.subscribe(() => {
      if (controller.getSnapshot().grid.preparation?.ready === 3) { unsubscribe(); resolve(); }
    });
  });
  releaseBackground(); await completed;
  assert.equal(requested.length, 3, 'each cloud hour downloads once while the wind catalog is still pending');
  controller.change({ awcGridMode: 'temperature' });
  controller.change({ awcGridMode: 'cloudCover' });
  assert.equal(controller.getSnapshot().grid.preparation?.ready, 3, 'switching shading retains cloud completion receipts');
  controller.setForecastInteraction('controls', false); await flush();
  assert.equal(jobs.filter(job => job.time === WEATHER_NOW + 3 * HOUR).length, 1, 'the saved distant hour is not prepared a second time');
  controller.detach();
});

test('advisories retain full text, native altitude qualifiers, independent forecast times and multipart geometry', () => {
  const g = advisorySnapshot('gairmet');
  assert.equal(g.advisories[0]!.altitude, 'Base FZL · Top 25,000 ft · Freezing 8,000 ft–12,000 ft');
  assert.equal(g.advisories[1]!.altitude, '12,000 ft MSL');
  assert.deepEqual(g.frameTimes, FORECAST_HOURS.map(hour => WEATHER_NOW + hour * HOUR));
  const c = advisorySnapshot('cwa').advisories[0]!;
  assert.equal(c.text, 'SYNTHETIC CWA TEST');
  assert.equal(c.issuedAt, null, 'do not manufacture an issue timestamp from validity');
  const s = advisorySnapshot('sigmet');
  assert.equal(s.advisories[0]!.altitude, 'TOPS ABV FL450', 'numeric bounds must not turn open-ended tops into an exact upper limit');
  assert.equal(c.altitude, 'See bulletin for vertical extent');
  assert.notEqual(s.advisories[0]!.id, s.advisories[1]!.id);
  assert.ok(isWeatherGeometry({ type: 'MultiPolygon', coordinates: [advisorySource('cwa').features[0]!.geometry.coordinates] }));
  assert.ok(!isWeatherGeometry({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] }));
  assert.ok(!isWeatherGeometry({ type: 'LineString', coordinates: [[NaN, 1], [0, 0]] }));
});

test('forecast refresh rejects truncation, mixed cycles, absent frames and malformed validity', () => {
  const inputs = FORECAST_HOURS.map(hour => advisorySource('gairmet', hour));
  assert.throws(() => normalizeAdvisories('gairmet', inputs.slice(0, 4), WEATHER_NOW, 'test'), /incomplete/);
  inputs[4] = advisorySource('gairmet', 12, WEATHER_NOW + 6 * HOUR);
  assert.throws(() => normalizeAdvisories('gairmet', inputs, WEATHER_NOW, 'test'), /changed during refresh/);
  inputs[0]!.features[0]!.properties.forecast = null;
  assert.throws(() => normalizeAdvisories('gairmet', inputs, WEATHER_NOW, 'test'), /invalid hazard or forecast times/);
  const c = advisorySource('cwa');
  assert.ok(!isSourceCollection({ ...c, exceededTransferLimit: true }));
  assert.ok(!isSourceCollection({ ...c, features: Array(400).fill(c.features[0]) }));
  c.features[0]!.properties.validTimeTo = 'not a time';
  assert.throws(() => normalizeAdvisories('cwa', [c], WEATHER_NOW, 'test'), /invalid hazard or forecast times/);
  const snapshot = advisorySnapshot('gairmet');
  snapshot.frameTimes[4]! += HOUR;
  assert.ok(!isAwcAdvisorySnapshot(snapshot));
});

test('CWA without a parsed hazard keeps its bulletin, geometry, validity and neighboring advisories', () => {
  assert.ok(isSourceCollection(cwaNullHazard));
  const checkedAt = Date.parse('2026-09-24T17:54:00Z');
  const snapshot = normalizeAdvisories('cwa', [cwaNullHazard], checkedAt, 'https://aviationweather.gov/api/data/cwa');
  assert.equal(snapshot.advisories.length, 2);
  const houston = snapshot.advisories.find(a => a.issuer === 'ZHU')!;
  const original = cwaNullHazard.features.find(f => f.properties.cwsu === 'ZHU')!;
  assert.equal(houston.identifier, '103');
  assert.equal(houston.hazard, 'UNK');
  assert.equal(advisoryHazard(houston), 'Unspecified hazard');
  assert.equal(houston.text, original.properties.cwaText);
  assert.equal(houston.altitude, 'TOPS TO FL400');
  assert.deepEqual(houston.geometry, original.geometry);
  assert.deepEqual(houston.sourceProperties, original.properties);
  assert.equal(houston.sourceProperties.hazard, null);
  assert.equal(houston.validFrom, Date.parse('2026-09-24T16:53:00Z'));
  assert.equal(houston.validTo, Date.parse('2026-09-24T17:56:00Z'));
  assert.equal(snapshot.advisories.find(a => a.issuer === 'ZKC')!.hazard, 'TS');
  assert.equal(advisoryFrame(snapshot, checkedAt).advisories.length, 2);
  assert.deepEqual(advisoryFrame(snapshot, houston.validTo!).advisories.map(a => a.issuer), ['ZKC']);
});

test('only missing CWA hazards get a fallback; malformed hazards and invalid times still fail', () => {
  const cwa = advisorySource('cwa');
  delete cwa.features[0]!.properties.hazard;
  assert.equal(normalizeAdvisories('cwa', [cwa], WEATHER_NOW, 'test').advisories[0]!.hazard, 'UNK');
  for (const hazard of [0, true, {}, [], '', ' ']) {
    cwa.features[0]!.properties.hazard = hazard;
    assert.throws(() => normalizeAdvisories('cwa', [cwa], WEATHER_NOW, 'test'), /invalid hazard/);
  }
  cwa.features[0]!.properties.hazard = null;
  cwa.features[0]!.properties.validTimeTo = cwa.features[0]!.properties.validTimeFrom;
  assert.throws(() => normalizeAdvisories('cwa', [cwa], WEATHER_NOW, 'test'), /forecast times/);
  for (const product of ['gairmet', 'sigmet'] as const) {
    const inputs = (product === 'gairmet' ? FORECAST_HOURS : [0]).map(hour => advisorySource(product, hour));
    inputs[0]!.features[0]!.properties.hazard = null;
    assert.throws(() => normalizeAdvisories(product, inputs, WEATHER_NOW, 'test'), /invalid hazard/);
  }
});

test('successful empty forecast frames are explicit; wholly empty packages do not invent forecast coverage', () => {
  const empty = { type: 'FeatureCollection' as const, features: [] };
  const inputs = FORECAST_HOURS.map(hour => hour === 0 ? advisorySource('gairmet', hour) : empty);
  const snapshot = normalizeAdvisories('gairmet', inputs, WEATHER_NOW, 'test');
  assert.deepEqual(advisoryFrame(snapshot, WEATHER_NOW + 6 * HOUR), { time: WEATHER_NOW + 6 * HOUR, advisories: [] });
  const noPackage = normalizeAdvisories('gairmet', Array(5).fill(empty), WEATHER_NOW, 'test');
  assert.deepEqual(advisoryFrame(noPackage, WEATHER_NOW), { time: undefined, advisories: [] });
});

test('snapshot selection advances at published times, respects the horizon and uses exclusive interval ends', () => {
  const g = advisorySnapshot('gairmet');
  assert.equal(advisoryFrame(g, WEATHER_NOW + 1.5 * HOUR).time, WEATHER_NOW);
  assert.equal(advisoryFrame(g, WEATHER_NOW + 3 * HOUR - 1).time, WEATHER_NOW, 'a future snapshot cannot appear before its timeline stop');
  assert.equal(advisoryFrame(g, WEATHER_NOW + 3 * HOUR).time, WEATHER_NOW + 3 * HOUR);
  assert.equal(advisoryFrame(g, WEATHER_NOW + 12 * HOUR + 1).time, undefined);
  assert.equal(advisoryFrame(g, WEATHER_NOW - 1).time, undefined);
  assert.equal(new Date(advisoryFrame(g, WEATHER_NOW + 6 * HOUR).time!).toISOString(), '2026-09-23T03:00:00.000Z');
  assert.equal(currentFrame([WEATHER_NOW, WEATHER_NOW + 6 * HOUR], WEATHER_NOW + 3 * HOUR, 3 * HOUR), undefined);
  const c = advisorySnapshot('cwa');
  assert.equal(advisoryFrame(c, WEATHER_NOW).advisories.length, 1);
  assert.equal(advisoryFrame(c, WEATHER_NOW + 2 * HOUR - 1).advisories.length, 1);
  assert.equal(advisoryFrame(c, WEATHER_NOW + 2 * HOUR).advisories.length, 0);
});

test('forecast stops use published times, skip gaps and retain a pinned frame after the clock passes it', () => {
  const times = [0, 3, 9, 12].map(hour => WEATHER_NOW + hour * HOUR);
  assert.deepEqual(forecastStops(times, WEATHER_NOW, null), [null, ...times.slice(1)]);
  assert.deepEqual(forecastStops(times, WEATHER_NOW + 4 * HOUR, times[1]!), [times[1], ...times.slice(2)], 'Next skips Now, which can resolve to the same pinned frame');
  assert.deepEqual(forecastStops(times, times[1]!, times[1]!), times.slice(1), 'a pinned stop survives the exact clock boundary');
  assert.deepEqual(forecastStops(times, WEATHER_NOW + 4 * HOUR, null), [null, ...times.slice(2)]);
  assert.deepEqual(forecastStops([], WEATHER_NOW, null), [null]);
  assert.deepEqual(forecastStops(times, WEATHER_NOW, WEATHER_NOW + HOUR), [null, ...times.slice(1)],
    'a selection retained from an inactive layer is not a change point');
  assert.deepEqual(forecastStops(times, WEATHER_NOW + 13 * HOUR, null), [null]);
});

test('Now keeps the preceding grid hour through its final minute without crossing gaps or the forecast horizon', () => {
  const times = [3, 0, 1].map(hour => WEATHER_NOW + hour * HOUR);
  assert.equal(currentFrame(times, WEATHER_NOW + HOUR - 1, HOUR), WEATHER_NOW);
  assert.equal(currentFrame(times, WEATHER_NOW + HOUR, HOUR), WEATHER_NOW + HOUR);
  assert.equal(currentFrame(times, WEATHER_NOW + 2 * HOUR, HOUR), undefined);
  assert.equal(currentFrame(times, WEATHER_NOW - 1, HOUR), undefined);
  assert.equal(currentFrame(times, WEATHER_NOW + 3 * HOUR + 1, HOUR), undefined);
  assert.equal(currentFrame([], WEATHER_NOW, HOUR), undefined);
});

test('enabled weather offers inspection without a toolbox and only selects after choosing its action', t => {
  environment(t);
  t.mock.timers.enable({ apis: ['Date'], now: WEATHER_NOW });
  const controller = createWeatherController({ restore: product => ({ snapshot: advisorySnapshot(product), loading: false }),
    refresh: async product => advisorySnapshot(product) });
  t.after(() => controller.detach());
  const enabled = { ...weatherAwcPreferences.select({ awcEnabled: true }), change() {} };
  controller.configure(enabled);
  const point = { x: 100, y: 100 }, id = controller.visibleAdvisories()[0]!.id;
  controller.setPicker(() => [id]);
  const action = controller.contextActions(point)[0]!;
  assert.equal(action.label, 'Inspect weather');
  assert.deepEqual(controller.getSnapshot().selectedIds, [], 'opening the menu does not select anything');
  action.select();
  const previous = controller.getSnapshot();
  assert.deepEqual(previous.selectedIds, [id]);
  action.select();
  assert.notEqual(controller.getSnapshot().selectedIds, previous.selectedIds, 'choosing the same advisory reopens details');
  controller.clearSelection();
  assert.equal(controller.contextActions(point)[0]!.label, 'Inspect weather');
  action.select();
  assert.deepEqual(controller.getSnapshot().selectedIds, [id], 'closing details does not revoke an offered action');
  controller.configure({ ...enabled, awcEnabled: false });
  assert.deepEqual(controller.contextActions(point), []);
  action.select();
  assert.deepEqual(controller.getSnapshot().selectedIds, []);
  controller.configure(enabled);
  controller.setPicker(() => []);
  assert.deepEqual(controller.contextActions(point), [], 'no action outside available weather');
  controller.detach();
  assert.deepEqual(controller.contextActions(point), []);
});

test('time selection requires a published frame and survives refresh only while that frame remains available', async t => {
  t.after(() => controller.detach());
  environment(t);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: WEATHER_NOW });
  let base = WEATHER_NOW;
  const controller = createWeatherController({ restore: product => ({ snapshot: advisorySnapshot(product), loading: false }),
    refresh: async product => advisorySnapshot(product, base) });
  const input = { ...weatherAwcPreferences.select({ awcEnabled: true }), change() {} };
  controller.configure(input);
  controller.selectTime(WEATHER_NOW + HOUR);
  assert.equal(controller.getSnapshot().selectedTime, null, 'no invented intermediate forecast');
  controller.selectTime(WEATHER_NOW + 6 * HOUR);
  controller.attach(); t.mock.timers.tick(0); await flush();
  assert.equal(controller.getSnapshot().selectedTime, WEATHER_NOW + 6 * HOUR);
  base += 6 * HOUR;
  t.mock.timers.tick(6 * HOUR); await flush();
  assert.equal(controller.getSnapshot().selectedTime, WEATHER_NOW + 6 * HOUR, 'same timestamp in replacement package');
  base += 6 * HOUR;
  t.mock.timers.tick(6 * HOUR); await flush();
  assert.equal(controller.getSnapshot().selectedTime, null, 'removed frame returns to Now');
  controller.selectTime(base + 3 * HOUR);
  controller.configure({ ...input, awcGairmet: false, awcFreezing: true });
  assert.equal(controller.getSnapshot().selectedTime, base + 3 * HOUR, 'freezing contours share the forecast frames');
  controller.configure({ ...input, awcGairmet: false, awcFreezing: false });
  assert.deepEqual(controller.forecastTimes(), [base, base + 2 * HOUR]);
  assert.equal(controller.getSnapshot().selectedTime, null, 'only the remaining SIGMET/CWA validity boundaries contribute stops');
});

test('snapshot refresh only caches complete successes; failures and cancellations retain the last package', async t => {
  environment(t);
  const urls: URL[] = [];
  let fail = false;
  t.mock.method(globalThis, 'fetch', async (input: string, options: RequestInit) => {
    assert.equal(options.cache, 'no-store');
    const url = new URL(input); urls.push(url);
    return fail ? new Response('outage', { status: 503 }) : Response.json(advisorySnapshot('gairmet'));
  });
  const client = new AdvisoryClient('https://app.test/api/weather/advisories/', true), signal = new AbortController().signal;
  const live = await client.refresh('gairmet', signal, WEATHER_NOW);
  assert.deepEqual(urls.map(u => u.href), ['https://app.test/api/weather/advisories/gairmet.json']);
  assert.deepEqual(client.restore('gairmet'), { snapshot: live, loading: false });
  assert.equal(new AdvisoryClient('https://other.test/').restore('gairmet').snapshot, undefined);
  fail = true;
  await assert.rejects(client.refresh('gairmet', signal, WEATHER_NOW + HOUR), /503/);
  assert.deepEqual(client.restore('gairmet').snapshot, live);
  const cancelled = new AbortController(); cancelled.abort(); fail = false;
  await assert.rejects(client.refresh('gairmet', cancelled.signal, WEATHER_NOW + HOUR), /abort/i);
  assert.deepEqual(client.restore('gairmet').snapshot, live);
});

test('published empty snapshots remove withdrawn advisories; future and wrong-product documents are rejected', async t => {
  environment(t);
  let body = advisorySnapshot('cwa');
  t.mock.method(globalThis, 'fetch', async () => Response.json(body));
  const client = new AdvisoryClient('https://feed.test/'), signal = new AbortController().signal;
  await client.refresh('cwa', signal, WEATHER_NOW);
  body = { ...body, advisories: [], checkedAt: WEATHER_NOW + 60_000 };
  await client.refresh('cwa', signal, WEATHER_NOW + 60_000);
  assert.deepEqual(client.restore('cwa').snapshot!.advisories, []);
  body = advisorySnapshot('sigmet');
  await assert.rejects(client.refresh('cwa', signal, WEATHER_NOW), /invalid product/);
  body = advisorySnapshot('cwa', WEATHER_NOW + HOUR);
  await assert.rejects(client.refresh('cwa', signal, WEATHER_NOW), /future source/);
});

test('gateway migration retains only matching AWC/NOAA snapshots without claiming a new source check', t => {
  environment(t);
  const baseUrl = 'https://app.test/api/weather/advisories/';
  const gateway = new AdvisoryClient(baseUrl, true), archive = new AdvisoryClient('https://other.test/');
  for (const product of ['gairmet', 'sigmet', 'cwa'] as const) {
    const endpoints = [baseUrl, 'https://app.test/weather/awc/snapshots/', 'https://app.test/weather/awc/', ...(product === 'gairmet' ? [] : [noaaAdvisoryUrl(product)])];
    for (const endpoint of endpoints) {
      const snapshot = { ...advisorySnapshot(product), ...(endpoint.includes('mapservices.weather.noaa.gov') ? { source: endpoint } : {}) };
      weatherStorage.slot(product).write(JSON.stringify({ endpoint, snapshot, fingerprint: 'a'.repeat(64) }));
      assert.deepEqual(gateway.restore(product), { snapshot, loading: false });
      assert.equal(archive.restore(product).snapshot, undefined, 'custom feeds cannot inherit gateway caches');
      if (endpoint !== baseUrl) assert.equal(new AdvisoryClient(baseUrl).restore(product).snapshot, undefined, 'migration is explicit');
    }
    const snapshot = advisorySnapshot(product);
    for (const endpoint of ['https://unrelated.test/', noaaAdvisoryUrl(product === 'sigmet' ? 'cwa' : 'sigmet')]) {
      weatherStorage.slot(product).write(JSON.stringify({ endpoint, snapshot }));
      assert.equal(gateway.restore(product).snapshot, undefined, 'unrelated source or another family cannot migrate');
    }
    weatherStorage.slot(product).write(JSON.stringify({ endpoint: baseUrl, snapshot: advisorySnapshot(product === 'cwa' ? 'sigmet' : 'cwa') }));
    assert.equal(gateway.restore(product).snapshot, undefined, 'a matching endpoint cannot override product validation');
  }
});

test('network-only JSON acquisition cancels oversized streams and rejects invalid/empty documents', async t => {
  assert.throws(() => weatherCheckedAt(new Response('', { headers: { 'X-Weather-Checked-At': 'tomorrow' } }), WEATHER_NOW));
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(100)); }, cancel() { cancelled = true; },
  })));
  await assert.rejects(requestJson('https://test/', isSourceCollection, 'Weather', { maxBytes: 50 }), /response limit/);
  assert.equal(cancelled, true);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ type: 'FeatureCollection', features: [{}] }));
  await assert.rejects(requestJson('https://test/', isSourceCollection, 'Weather'), /invalid document/);
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
  await assert.rejects(requestJson('https://test/', isSourceCollection, 'Weather'), /no document/);
});

test('controller isolates failures, pins time across refreshes, expires offline at interval ends and stops demand', async t => {
  t.after(() => controller.detach());
  const env = environment(t);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: WEATHER_NOW });
  const calls: AwcAdvisoryProduct[] = [];
  const controller = createWeatherController({ restore: () => ({ loading: false }), async refresh(product) {
    calls.push(product);
    if (product === 'sigmet') throw new Error('source outage');
    const snapshot = advisorySnapshot(product);
    if (product === 'cwa') snapshot.advisories[0]!.validTo = WEATHER_NOW + 6_000;
    return snapshot;
  } });
  const input = { ...weatherAwcPreferences.select({ awcEnabled: true }), change() {} };
  controller.configure(input); controller.attach();
  t.mock.timers.tick(0); await flush();
  assert.equal(calls.length, 3);
  assert.equal(controller.getSnapshot().products.sigmet.error, 'source outage');
  assert.equal(controller.visibleAdvisories().filter(a => a.product === 'cwa').length, 1);
  env.navigator.onLine = false; env.window.dispatchEvent(new Event('offline'));
  t.mock.timers.tick(6_000); await flush();
  assert.equal(controller.visibleAdvisories().filter(a => a.product === 'cwa').length, 0);
  controller.selectTime(WEATHER_NOW + 6 * HOUR);
  assert.equal(controller.visibleAdvisories()[0]!.validFrom, WEATHER_NOW + 6 * HOUR);
  controller.configure({ ...input, awcIcing: false });
  assert.deepEqual(controller.visibleAdvisories(), []);
  t.mock.timers.tick(6 * 60_000); await flush();
  assert.equal(calls.length, 3, 'offline does not poll');
  controller.configure(input);
  env.navigator.onLine = true; env.window.dispatchEvent(new Event('online'));
  t.mock.timers.tick(0); await flush();
  assert.equal(controller.getSnapshot().selectedTime, WEATHER_NOW + 6 * HOUR);
  assert.equal(calls.length, 6);
  controller.configure({ ...input, awcEnabled: false });
  t.mock.timers.tick(6 * 60_000); await flush();
  assert.equal(calls.length, 6);
  assert.deepEqual(controller.visibleAdvisories(), []);
});

test('fresh grid data advances Now even while mobile clock timers are suspended', async t => {
  t.after(() => controller.detach());
  environment(t);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: WEATHER_NOW });
  const resumedAt = WEATHER_NOW + 8 * HOUR, fixture = gridFixture('clouds', 2, resumedAt);
  const grids = new GridClient('https://app.test/api/weather/grids/');
  let release!: () => void;
  const refreshed = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(grids, 'refresh', async () => { await refreshed; return fixture.manifest; });
  const requested: number[] = [];
  t.mock.method(grids, 'load', async (_manifest: unknown, frame: { validTime: number }) => {
    requested.push(frame.validTime); throw new Error('Raster loading ends this fixture');
  });
  t.mock.method(grids, 'prepare', async () => { throw new Error('Background loading ends this fixture'); });
  const controller = createWeatherController({ restore: () => ({ loading: false }), refresh: async product => advisorySnapshot(product) }, grids);
  controller.configure({ ...weatherAwcPreferences.select({ awcEnabled: true, awcGridMode: 'cloudCover',
    awcGairmet: false, awcSigmet: false, awcConvective: false, awcCwa: false }), change() {} });
  controller.attach(); t.mock.timers.tick(0); await flush();
  // Move only Date, without delivering the periodic timer or a visibility event.
  t.mock.timers.setTime(resumedAt);
  assert.equal(controller.getSnapshot().now, WEATHER_NOW);
  release(); await flush();
  assert.equal(controller.getSnapshot().now, resumedAt);
  assert.equal(controller.getSnapshot().selectedTime, null);
  assert.equal(controller.getSnapshot().grid.products.clouds.manifest?.generation, fixture.manifest.generation);
  assert.deepEqual(requested, [resumedAt], 'the map requests the current hour from the refreshed catalog');
});

test('Now actions and page resume update the clock immediately while preserving a pinned forecast', t => {
  const env = environment(t);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: WEATHER_NOW });
  const controller = createWeatherController({ restore: product => ({ snapshot: advisorySnapshot(product), loading: false }),
    refresh: async product => advisorySnapshot(product) });
  t.after(() => controller.detach());
  controller.configure({ ...weatherAwcPreferences.select({ awcEnabled: true }), change() {} });
  controller.attach();
  t.mock.timers.setTime(WEATHER_NOW + HOUR);
  controller.selectTime(null);
  assert.equal(controller.getSnapshot().now, WEATHER_NOW + HOUR, 'Now works even when already selected');
  controller.selectTime(WEATHER_NOW + 9 * HOUR);
  for (const [index, name] of ['pageshow', 'focus'].entries()) {
    const resumedAt = WEATHER_NOW + (index + 2) * HOUR;
    t.mock.timers.setTime(resumedAt); env.window.dispatchEvent(new Event(name));
    assert.equal(controller.getSnapshot().now, resumedAt);
    assert.equal(controller.getSnapshot().selectedTime, WEATHER_NOW + 9 * HOUR);
  }
  t.mock.timers.setTime(WEATHER_NOW + 4 * HOUR); controller.selectTime(null);
  assert.equal(controller.getSnapshot().now, WEATHER_NOW + 4 * HOUR);
  assert.equal(controller.visibleAdvisories().find(a => a.product === 'gairmet')?.validFrom, WEATHER_NOW + 3 * HOUR);
  controller.detach();
  const stopped = controller.getSnapshot();
  t.mock.timers.setTime(WEATHER_NOW + 5 * HOUR);
  for (const name of ['pageshow', 'focus']) env.window.dispatchEvent(new Event(name));
  assert.equal(controller.getSnapshot(), stopped, 'detached controllers release resume listeners');
});

test('timeline steps follow displayed products and altitude while the shared selection survives changing fields', t => {
  environment(t);
  const clouds = gridFixture('clouds').manifest, icing = gridFixture('icing').manifest;
  const selected = WEATHER_NOW + HOUR;
  icing.frames = icing.frames.filter(frame => frame.validTime !== selected || frame.altitudeFtMsl === 12000);
  const grids = new GridClient('https://app.test/');
  t.mock.method(grids, 'restore', (product: 'clouds' | 'icing') => ({ manifest: product === 'clouds' ? clouds : icing, loading: false }));
  const controller = createWeatherController({
    restore: product => ({ snapshot: advisorySnapshot(product), loading: false }),
    refresh: async product => advisorySnapshot(product),
  }, grids);
  const input = { ...weatherAwcPreferences.select({ awcEnabled: true }), change() {} };
  controller.configure(input);
  assert.equal(controller.forecastTimes().includes(selected), false, 'an inactive grid must not add empty hourly steps to advisories');
  assert.ok(controller.forecastTimes().includes(WEATHER_NOW + 12 * HOUR));
  controller.configure({ ...input, awcGridMode: 'cloudCover' });
  assert.ok(controller.forecastTimes().includes(selected));
  controller.selectTime(selected);
  for (const awcGridMode of ['cloudCover', 'icingSeverity', 'freezingHighest', 'none'] as const) {
    controller.configure({ ...input, awcGridMode, awcGridAltitude: 8000 });
    assert.equal(controller.getSnapshot().selectedTime, selected);
    assert.equal(controller.forecastTimes().includes(selected), awcGridMode === 'cloudCover' || awcGridMode === 'freezingHighest');
  }
  controller.configure({ ...input, awcGridMode: 'icingSeverity', awcGridAltitude: 12000 });
  assert.ok(controller.forecastTimes().includes(selected), 'only the altitude with this forecast contributes its step');
  controller.selectTime(selected + 15 * 60_000);
  assert.equal(controller.getSnapshot().selectedTime, selected, 'no synthetic intermediate stop is added');
});

test('timeline unions actual advisory validity boundaries and grid frames for enabled products only', t => {
  environment(t);
  const snapshots = { gairmet: advisorySnapshot('gairmet'), sigmet: advisorySnapshot('sigmet'), cwa: advisorySnapshot('cwa') };
  const convective = snapshots.sigmet.advisories.find(a => a.hazard === 'CONVECTIVE')!;
  convective.validFrom = WEATHER_NOW + 17 * 60_000;
  convective.validTo = WEATHER_NOW + 102 * 60_000;
  const cwa = snapshots.cwa.advisories[0]!;
  cwa.validFrom = WEATHER_NOW + 31 * 60_000;
  cwa.validTo = WEATHER_NOW + 56 * 60_000;
  const clouds = gridFixture('clouds').manifest;
  const grids = new GridClient('https://app.test/');
  t.mock.method(grids, 'restore', (product: string) => ({ loading: false, ...(product === 'clouds' ? { manifest: clouds } : {}) }));
  const controller = createWeatherController({ restore: product => ({ snapshot: snapshots[product], loading: false }),
    refresh: async product => snapshots[product] }, grids);
  const input = { ...weatherAwcPreferences.select({ awcEnabled: true, awcGridMode: 'cloudCover' }), change() {} };
  controller.configure(input);
  assert.deepEqual(controller.forecastTimes(), [...new Set([
    ...snapshots.gairmet.frameTimes, ...clouds.frames.map(frame => frame.validTime),
    ...[17, 102, 31, 56, 120].map(minute => WEATHER_NOW + minute * 60_000),
  ])].sort((a, b) => a - b));
  assert.deepEqual(controller.forecastChanges().find(change => change.time === convective.validFrom)?.products, ['sigmet']);
  assert.deepEqual(controller.forecastChanges().find(change => change.time === WEATHER_NOW + 3 * HOUR)?.products, ['gairmet', 'clouds']);
  controller.selectTime(convective.validFrom);
  assert.ok(controller.visibleAdvisories().some(a => a.id === convective.id));
  assert.equal(controller.visibleAdvisories().find(a => a.product === 'gairmet')?.validFrom, WEATHER_NOW);
  controller.selectTime(convective.validTo);
  assert.ok(!controller.visibleAdvisories().some(a => a.id === convective.id));
  controller.configure({ ...input, awcConvective: false, awcCwa: false, awcSigmet: false });
  assert.deepEqual(controller.forecastTimes(), [...new Set([
    ...snapshots.gairmet.frameTimes, ...clouds.frames.map(frame => frame.validTime),
  ])].sort((a, b) => a - b));
});

test('surface file restoration survives failed refreshes, cannot replace live data, and stops on detach', async t => {
  environment(t);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: WEATHER_NOW });
  const saved: SurfaceSnapshot = { schemaVersion: 2, product: 'analysis', checkedAt: WEATHER_NOW,
    source: 'https://test/catalog', sourceHash: 'a'.repeat(64), sourceCatalog: '{}', frames: [] };
  const live = { ...saved, sourceHash: 'b'.repeat(64) };
  let restore!: (state: SurfaceState) => void, restoreSignal!: AbortSignal;
  let finish!: (value: SurfaceSnapshot) => void, fail!: (reason: Error) => void;
  const controller = createWeatherController({ restore: () => ({ loading: false }), refresh: async product => advisorySnapshot(product) }, undefined, {
    restore: async (product, signal) => {
      if (product === 'forecast') return { loading: false };
      restoreSignal = signal;
      return new Promise<SurfaceState>(resolve => { restore = resolve; });
    }, refresh: async product => product === 'forecast' ? { ...live, product } : new Promise<SurfaceSnapshot>((resolve, reject) => { finish = resolve; fail = reject; }),
  });
  t.after(() => controller.detach());
  controller.configure({ ...weatherAwcPreferences.select({ awcEnabled: true, awcProgs: true }), change() {} });
  controller.attach(); t.mock.timers.tick(0); await flush();
  restore({ snapshot: saved, loading: false }); await flush();
  fail(new Error('Offline')); await flush();
  assert.equal(controller.getSnapshot().progs.analysis.snapshot, saved, 'refresh failure retains a snapshot restored while the request was pending');
  assert.equal(controller.getSnapshot().progs.analysis.error, 'Offline');
  controller.attach(); t.mock.timers.tick(0); await flush();
  finish(live); await flush(); restore({ snapshot: saved, loading: false }); await flush();
  assert.equal(controller.getSnapshot().progs.analysis.snapshot, live, 'late restoration cannot overwrite newer live charts');
  controller.attach(); t.mock.timers.tick(0); await flush();
  controller.detach();
  assert.equal(restoreSignal.aborted, true);
  restore({ snapshot: saved, loading: false }); finish(saved); await flush();
  assert.equal(controller.getSnapshot().progs.analysis.snapshot, live, 'detached work cannot publish');
});

test('late work cannot publish after detach/remount and all loading flags clear on cancellation', async t => {
  environment(t);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: WEATHER_NOW });
  let complete: (() => void) | undefined;
  let oldSignal: AbortSignal | undefined;
  const controller = createWeatherController({ restore: () => ({ loading: false }),
    async refresh(product, signal) {
      oldSignal = signal;
      await new Promise<void>(resolve => { complete = resolve; });
      return advisorySnapshot(product);
    },
  });
  controller.configure({ ...weatherAwcPreferences.select({ awcEnabled: true }), change() {} });
  controller.attach(); t.mock.timers.tick(0); await flush();
  controller.detach();
  assert.equal(oldSignal!.aborted, true);
  assert.ok(Object.values(controller.getSnapshot().products).every(p => !p.loading));
  controller.attach(); complete!(); await flush();
  assert.ok(Object.values(controller.getSnapshot().products).every(p => !p.snapshot));
  controller.detach();
});

test('advisory reattachment keeps shading below route/navigation layers and releases map resources', t => {
  t.after(() => host.unmount());
  const env = environment(t); env.navigator.onLine = false;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: WEATHER_NOW });
  const controller = createWeatherController({ restore: product => ({ snapshot: advisorySnapshot(product), loading: false }),
    refresh: async () => { throw new Error('Offline must not request'); } });
  controller.configure({ ...weatherAwcPreferences.select({ awcEnabled: true }), change() {} });
  const sources = new Map<string, unknown>();
  const order = [WEATHER_LAYER_ANCHOR, 'route-line', ROUTE_LINE_ANCHOR, 'navigation'];
  let writes = 0;
  const map = { addSource(id: string, source: unknown) { sources.set(id, source); },
    getSource(id: string) { return sources.has(id) ? { setData() { writes++; } } : undefined; },
    removeSource(id: string) { sources.delete(id); },
    addLayer(layer: { id: string }, before: string) { assert.ok(order.includes(before)); order.splice(order.indexOf(before), 0, layer.id); },
    getLayer(id: string) { return order.includes(id); }, removeLayer(id: string) { order.splice(order.indexOf(id), 1); },
    queryRenderedFeatures() { return []; }, setLayoutProperty() {}, hasImage() { return false; }, on() {}, off() {},
  } as unknown as MapLibreMap;
  const host = new MapLayerHost(map, (_id, error) => { throw error; });
  const layer = createWeatherMap(controller);
  for (let i = 0; i < 3; i++) {
    host.reconcile([layer]);
    assert.deepEqual(order, [...ADVISORY_LAYERS, WEATHER_LAYER_ANCHOR, 'route-line', ROUTE_LINE_ANCHOR, 'navigation']);
    assert.ok(writes > i, 'saved data renders immediately on attachment');
    host.reconcile([]);
    assert.equal(sources.size, 0);
    assert.deepEqual(order, [WEATHER_LAYER_ANCHOR, 'route-line', ROUTE_LINE_ANCHOR, 'navigation']);
  }
});

test('advisory source failures clear shown counts and recover unchanged IDs without changing layer order', async t => {
  const env = environment(t); env.navigator.onLine = false;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: WEATHER_NOW });
  const controller = createWeatherController({ restore: product => ({ snapshot: advisorySnapshot(product), loading: false }),
    refresh: async () => { throw new Error('Offline must not request'); } });
  controller.configure({ ...weatherAwcPreferences.select({ awcEnabled: true }), change() {} });
  type Layer = { id: string; layout?: Record<string, unknown> };
  const layers: Layer[] = [{ id: WEATHER_LAYER_ANCHOR }, { id: 'navigation' }];
  const sources = new Set<string>(), handlers = new Set<(event: { sourceId: string; error: Error }) => void>();
  const writes: { resolve: () => void; reject: (error: Error) => void }[] = [];
  const map = {
    addSource(id: string) { sources.add(id); }, removeSource(id: string) { sources.delete(id); },
    getSource(id: string) { return sources.has(id) ? { setData: () => new Promise<void>((resolve, reject) => { writes.push({ resolve, reject }); }) } : undefined; },
    getStyle: () => ({ layers }), getLayer: (id: string) => layers.find(layer => layer.id === id),
    addLayer(layer: Layer, before?: string) { layers.splice(before ? layers.findIndex(item => item.id === before) : layers.length, 0, layer); },
    removeLayer(id: string) { layers.splice(layers.findIndex(layer => layer.id === id), 1); },
    setLayoutProperty(id: string, property: string, value: unknown) { (layers.find(layer => layer.id === id)!.layout ??= {})[property] = value; },
    queryRenderedFeatures: () => [], hasImage: () => false,
    on(name: string, listener: (event: { sourceId: string; error: Error }) => void) { if (name === 'error') handlers.add(listener); },
    off(name: string, listener: (event: { sourceId: string; error: Error }) => void) { if (name === 'error') handlers.delete(listener); },
  };
  const host = new MapLayerHost(map as unknown as MapLibreMap, (_id, error) => { throw error; }); t.after(() => host.unmount());
  const layer = createWeatherMap(controller); host.reconcile([layer]);
  assert.equal(writes.length, 1); assert.equal(controller.getSnapshot().advisoryDisplay.loading, true);
  assert.deepEqual(controller.getSnapshot().advisoryDisplay.ids, [], 'submission does not count as rendered');
  map.addLayer({ id: 'retained-wind' }, ADVISORY_LAYERS[1]);
  map.addLayer({ id: 'retained-radar' }, WEATHER_LAYER_ANCHOR);
  map.addLayer({ id: 'retained-progs' }, WEATHER_LAYER_ANCHOR);
  const order = layers.map(layer => layer.id);
  const fail = () => { for (const listener of handlers) listener({ sourceId: 'weather-awc-advisories', error: new Error('Worker failed') }); };
  fail(); writes[0]!.resolve(); await flush();
  assert.match(controller.getSnapshot().advisoryDisplay.error!, /Worker failed/);
  assert.deepEqual(controller.getSnapshot().advisoryDisplay.ids, []);
  assert.ok(ADVISORY_LAYERS.every(id => map.getLayer(id)!.layout!.visibility === 'none'));
  layer.update(); assert.equal(writes.length, 1, 'ordinary updates cannot loop failed worker submissions');
  controller.retryAdvisories(); assert.equal(writes.length, 2);
  assert.deepEqual(layers.map(layer => layer.id), order, 'recovery retains wind, radar, Progs and navigation insertion points');
  writes[1]!.resolve(); await flush();
  assert.equal(controller.getSnapshot().advisoryDisplay.error, undefined);
  assert.deepEqual(controller.getSnapshot().advisoryDisplay.ids, controller.visibleAdvisories().map(advisory => advisory.id));
  fail(); controller.retryAdvisories(); writes[2]!.reject(new Error('Source rejected')); await flush();
  assert.match(controller.getSnapshot().advisoryDisplay.error!, /Source rejected/);
  controller.retryAdvisories(); host.unmount(); writes[3]!.resolve(); await flush();
  assert.deepEqual(controller.getSnapshot().advisoryDisplay, { loading: false, ids: [] });
  assert.equal(handlers.size, 0); assert.equal(sources.size, 0);
});

test('G-AIRMET severity is preserved and displayed without reinterpreting SIGMET numeric codes', () => {
  const inputs = FORECAST_HOURS.map(hour => advisorySource('gairmet', hour));
  for (const input of inputs) input.features[0]!.properties.severity = 'MOD';
  const snapshot = normalizeAdvisories('gairmet', inputs, WEATHER_NOW, 'test');
  const advisory = snapshot.advisories[0]!;
  assert.equal(advisory.severity, 'MOD');
  assert.equal(advisoryHazard(advisory), 'Moderate · Icing');
  const legacy = { ...advisory }; delete legacy.severity;
  assert.equal(advisoryHazard(legacy), 'Moderate · Icing');
  assert.ok(isAwcAdvisorySnapshot({ ...snapshot, advisories: [legacy] }));
  const sigmet = advisorySnapshot('sigmet').advisories[0]!;
  sigmet.sourceProperties.severity = 5;
  assert.ok(!advisoryHazard(sigmet).includes('Severe'));
});
