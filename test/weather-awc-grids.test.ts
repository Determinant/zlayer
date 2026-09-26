import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { AWC_GRID_FIELDS, isAwcGridManifest, GRID_BELOW_GROUND, GRID_MISSING, GRID_UNKNOWN, GRID_OUTSIDE } from '@zlayer/contracts';
import { gridFixture } from './fixtures/awc-grids';
import { WEATHER_NOW } from './fixtures/awc-advisories';
import { decodeGrid, gridCell, gridValue, gridKey, gridMatchesTime, type DecodedGrid } from '../src/layers/weather-awc/grids/format';
import { forecastIsStale, gridValueLabel, gridColorizer, gridLegend, pointForecastGroups } from '../src/layers/weather-awc/grids/presentation';
import { rasterGrid } from '../src/layers/weather-awc/grids/raster';
import { createGridController, gridTimes } from '../src/layers/weather-awc/grids/controller';
import { GridClient } from '../src/layers/weather-awc/grids/client';
import { gridViewport } from '../src/layers/weather-awc/grids/viewport';
import { mountGridMap } from '../src/layers/weather-awc/grids/map';
import { weatherAwcPreferences } from '../src/layers/weather-awc/preferences';
import type { WeatherController } from '../src/layers/weather-awc/controller';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { cacheFixture } from './helpers/cache';

const signal = () => new AbortController().signal;
const bytes = (input: string) => Uint8Array.from(Buffer.from(input, 'base64')).buffer;
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('point forecasts share metadata only for matching provider, model run and valid time', () => {
  const forecast = (product: Parameters<typeof gridFixture>[0]): DecodedGrid => {
    const { manifest } = gridFixture(product), frame = manifest.frames.find(frame => frame.validTime === WEATHER_NOW)!;
    const values = new Float32Array(manifest.grid.width * manifest.grid.height * manifest.fields.length);
    return { manifest, frame, values, byteLength: values.byteLength, endpoint: 'https://app.test/api/weather/grids/' };
  };
  const clouds = forecast('clouds'), winds = forecast('winds'), icing = forecast('icing');
  clouds.frame.sources = ['https://nomads.ncep.noaa.gov/hrrr-surface.grib2'];
  winds.frame.sources = ['https://nomads.ncep.noaa.gov/hrrr-pressure.grib2', 'https://nomads.ncep.noaa.gov/hrrr-terrain.grib2'];
  assert.deepEqual(pointForecastGroups([clouds, winds]), [[clouds, winds]], 'surface and pressure files share the same HRRR forecast');
  winds.manifest.checkedAt += 60_000;
  assert.deepEqual(pointForecastGroups([clouds, winds]), [[clouds, winds]], 'separate acquisition times do not split the shared forecast identity');
  for (const different of [
    icing,
    { ...winds, manifest: { ...winds.manifest, runTime: winds.manifest.runTime - 3600000 } },
    { ...winds, frame: { ...winds.frame, validTime: winds.frame.validTime + 3600000 } },
    { ...winds, endpoint: 'https://archive.test/weather/' },
    { ...winds, frame: { ...winds.frame, sources: ['https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr-pressure.grib2'] } },
  ]) {
    assert.deepEqual(pointForecastGroups([clouds, different]), [[clouds], [different]]);
  }
  assert.deepEqual(pointForecastGroups([]), []);
});

// Controller tests replace I/O while preserving the client's decoded-cache contract.
function rememberLoadedFrames(t: TestContext, client: GridClient, saveMetadata = true) {
  const values = new Map<string, Awaited<ReturnType<GridClient['load']>>>(), load = client.load.bind(client);
  const neighborhood = client.neighborhood.bind(client);
  t.mock.method(client, 'neighborhood', (...args: Parameters<GridClient['neighborhood']>) => {
    neighborhood(...args);
    for (const [key, data] of values) if (!client.wants(data.manifest, data.frame)) values.delete(key);
  });
  t.mock.method(client, 'saved', () => true);
  t.mock.method(client, 'checkSaved', async (...args: Parameters<GridClient['checkSaved']>) => args[1].map(frame => {
    const value = values.get(gridKey(args[0], frame)); return value ? client.saved(value) : true;
  }));
  if (saveMetadata) t.mock.method(client, 'remember', () => true);
  t.mock.method(client, 'peek', (manifest: Parameters<GridClient['load']>[0], frame: Parameters<GridClient['load']>[1]) =>
    client.wants(manifest, frame) ? values.get(gridKey(manifest, frame)) : undefined);
  t.mock.method(client, 'load', async (...args: Parameters<GridClient['load']>) => {
    const data = await load(...args);
    if (!args[2].aborted && client.wants(args[0], args[1])) values.set(gridKey(args[0], args[1]), data);
    return data;
  });
  // These controller simulations replace storage too. Do not let real cache
  // inventory/crypto I/O determine when their explicitly completed jobs start.
  t.mock.method(client, 'prepare', async (...args: Parameters<GridClient['prepare']>) => {
    const memory = client.peek(args[0], args[1]);
    if (memory && (client.saved(memory) || !args[3])) return client.saved(memory);
    return client.saved(await client.load(...args));
  });
}

test('grid manifests reject unsafe paths, duplicates, mismatched heights, fields, horizons and excessive allocations', () => {
  for (const product of ['clouds', 'icing'] as const) assert.ok(isAwcGridManifest(gridFixture(product).manifest));
  const original = gridFixture('icing').manifest;
  for (const mutate of [
    (m: typeof original) => { m.frames[0]!.path = 'runs/../../secret.zwg.gz'; },
    (m: typeof original) => { m.frames.push(m.frames[0]!); },
    (m: typeof original) => { m.frames[0]!.altitudeFtMsl = 750; },
    (m: typeof original) => { m.frames[0]!.validTime = m.runTime; },
    (m: typeof original) => { m.frames[0]!.validTime = m.runTime + 19 * 3600000; },
    (m: typeof original) => { m.fields = ['icingSeverity', 'icingProbability', 'sldPotential']; },
    (m: typeof original) => { m.grid.width = 4096; m.grid.height = 4096; },
    (m: typeof original) => { m.frames[0]!.sources = ['https://evil.example/data']; },
  ]) { const value = structuredClone(original); mutate(value); assert.equal(isAwcGridManifest(value), false); }
});

test('numeric bundles verify hash/header/length/value ranges and sample Web Mercator north-to-south cells', async () => {
  const { manifest, files } = gridFixture('clouds'), frame = manifest.frames[1]!;
  const source = bytes(files[frame.path]!);
  const grid = await decodeGrid(source, manifest, frame, signal());
  assert.equal(gridValue(grid, 'cloudBase', 0), 2100);
  assert.equal(gridValue(await decodeGrid(source, manifest, { ...frame, sha256: frame.sha256.toUpperCase() }, signal()), 'cloudBase', 0), 2100);
  assert.equal(gridCell(manifest, -126, 51), 0);
  assert.equal(gridCell(manifest, -65.001, 22.001), 47);
  assert.equal(gridCell(manifest, -130, 40), undefined);
  assert.equal(gridCell(manifest, -65, 40), undefined);
  const middleY = Math.atan(Math.sinh((Math.asinh(Math.tan(22 * Math.PI / 180)) + Math.asinh(Math.tan(51 * Math.PI / 180))) / 2)) * 180 / Math.PI;
  assert.equal(gridCell(manifest, -95.5, middleY + 0.001), 20);
  await assert.rejects(decodeGrid(source, manifest, { ...frame, sha256: '0'.repeat(64) }, signal()), /checksum/);
  await assert.rejects(decodeGrid(source.slice(1), manifest, frame, signal()), /size/);
  for (const mutate of [(raw: Buffer) => raw.writeUInt16LE(9, 10), (raw: Buffer) => raw.writeFloatLE(NaN, 16), (raw: Buffer) => raw.writeFloatLE(101, 16)]) {
    const raw = gunzipSync(source); mutate(raw); const changed = gzipSync(raw);
    await assert.rejects(decodeGrid(Uint8Array.from(changed).buffer, manifest,
      { ...frame, bytes: changed.length, sha256: createHash('sha256').update(changed).digest('hex') }, signal()), /metadata|invalid value/);
  }
  await assert.rejects(decodeGrid(source, manifest, { ...frame, decodedBytes: 20 }, signal()), /decoded size/);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(decodeGrid(source, manifest, frame, aborted.signal), /abort/i);
});

test('valid zero, unknown, missing, outside and below terrain keep distinct point meanings; SLD is not percent', () => {
  const values = [0, GRID_MISSING, GRID_UNKNOWN, GRID_BELOW_GROUND, GRID_OUTSIDE];
  assert.equal(new Set(values.map(v => gridValueLabel('icingSeverity', v))).size, 5);
  assert.equal(gridValueLabel('icingSeverity', 4), 'Severe');
  assert.equal(gridValueLabel('sldPotential', 0.3), '0.30');
  assert.equal(gridValueLabel('sldPotential', 0), 'No SLD forecast (0.00)');
  assert.equal(gridValueLabel('sldPotential', GRID_UNKNOWN), 'SLD undetermined');
  assert.equal(gridValueLabel('sldPotential', GRID_MISSING), 'Not available');
  assert.equal(gridValueLabel('cloudBase', GRID_MISSING), 'No cloud base diagnosed');
  assert.equal(gridValueLabel('cloudTop', GRID_MISSING), 'No cloud top diagnosed');
  assert.equal(gridValueLabel('cloudCover', GRID_MISSING), 'Not available');
  assert.equal(gridValueLabel('cloudBase', 0), '0 ft MSL');
  assert.equal(gridValueLabel('icingProbability', 30), '30%');
  for (const field of Object.values(AWC_GRID_FIELDS).flat()) {
    const color = gridColorizer(field);
    for (const unavailable of [GRID_MISSING, GRID_UNKNOWN, GRID_BELOW_GROUND, GRID_OUTSIDE]) {
      for (const [x, y] of [[0, 0], [4, 5], [3, 2]] as const) {
        assert.equal(color(unavailable, x, y, undefined)[3], 0, `${field}: unavailable cells stay unshaded`);
        assert.equal(color(unavailable, x, y, 0.25)[3], 0, `${field}: SLD cannot shade an unavailable field`);
      }
    }
    const zeroIsWeatherAbsence = ['cloudCover', 'icingProbability', 'icingSeverity', 'sldPotential'].includes(field);
    assert.equal(color(0, 0, 0, undefined)[3]! > 0, !zeroIsWeatherAbsence, `${field}: zero heights remain visible`);
    assert.ok(color(1, 0, 0, undefined)[3]! > 0, `${field}: positive weather values remain visible`);
  }
  const color = gridColorizer('icingProbability');
  assert.ok(color(0, 0, 0, 0.25)[3]! > 0, 'positive SLD remains visible even when icing probability is zero');
  assert.notDeepEqual(color(30, 0, 0, 0.25), color(30, 0, 0, 0));
});

test('identical payloads at different times, heights or spatial/source identities cannot reuse old labels', () => {
  const manifest = gridFixture('icing').manifest, frame = manifest.frames[0]!;
  const key = gridKey(manifest, frame);
  assert.notEqual(key, gridKey(manifest, { ...frame, validTime: frame.validTime + 3600000 }));
  assert.notEqual(key, gridKey(manifest, { ...frame, altitudeFtMsl: 1000 }));
  assert.notEqual(key, gridKey(manifest, { ...frame, path: frame.path.replace('f1-', 'f2-') }));
  assert.notEqual(key, gridKey({ ...manifest, grid: { ...manifest.grid, bounds: [-125, 22, -65, 51] } }, frame));
  assert.notEqual(key, gridKey({ ...manifest, checkedAt: manifest.checkedAt + 1000 }, frame));
  assert.equal(key, gridKey(manifest, { ...frame, sha256: frame.sha256.toUpperCase() }));
});

for (const width of [7, 53]) test(`raster bytes preserve palettes, transparent cells and SLD hatching at width ${width} and fractional densities`, async () => {
  for (const product of ['clouds', 'icing'] as const) {
    const fixture = gridFixture(product), frame = fixture.manifest.frames[1]!;
    const data = await decodeGrid(bytes(fixture.files[frame.path]!), fixture.manifest, frame, signal());
    const count = data.manifest.grid.width * data.manifest.grid.height;
    for (const [band, field] of data.manifest.fields.entries()) {
      const samples = [GRID_MISSING, GRID_UNKNOWN, GRID_BELOW_GROUND, GRID_OUTSIDE, 0, 1,
        ...gridLegend(field).flatMap(bin => Number.isFinite(bin.max) ? [bin.max - .001, bin.max, bin.max + .001] : [])];
      for (let cell = 0; cell < count; cell++) data.values[band * count + cell] = samples[cell % samples.length]!;
    }
    // More than fourteen screen rows per model row exercises both row reuse and
    // all hatch phases; each next model row has different values and masks.
    const height = 149;
    const columns = Int32Array.from({ length: width }, (_, x) => Math.floor(x * data.manifest.grid.width / width));
    const rows = Int32Array.from({ length: height }, (_, y) => Math.floor(y * data.manifest.grid.height / height) * data.manifest.grid.width);
    for (const field of data.manifest.fields) for (const pixelRatio of [1, 1.25, 2]) for (const sld of [false, true]) {
      const viewport = { width, height, columns, rows, pixelRatio, bounds: data.manifest.grid.bounds, key: 'test' };
      const actual = await rasterGrid(data, field, sld, viewport, signal());
      const expected = new Uint8ClampedArray(width * height * 4), color = gridColorizer(field);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const cell = rows[y]! + columns[x]!;
        expected.set(color(gridValue(data, field, cell), Math.floor(x / pixelRatio), Math.floor(y / pixelRatio),
          sld && product === 'icing' && field !== 'sldPotential' ? gridValue(data, 'sldPotential', cell) : undefined), (y * width + x) * 4);
      }
      assert.deepEqual(actual, expected, `${field}, density ${pixelRatio}, SLD ${sld}`);
    }
  }
});

test('raster work yields to input and aborts before allocation or after a drawing slice', async t => {
  const fixture = gridFixture('clouds'), frame = fixture.manifest.frames[1]!;
  const data = await decodeGrid(bytes(fixture.files[frame.path]!), fixture.manifest, frame, signal());
  const view = { width: 64, height: 64, pixelRatio: 1, bounds: data.manifest.grid.bounds, key: 'test',
    columns: new Int32Array(64), rows: new Int32Array(64) };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 0;
  t.mock.method(performance, 'now', () => clock += 8);
  for (const drawFirstSlice of [false, true]) {
    const task = new AbortController(), result = rasterGrid(data, 'cloudCover', false, view, task.signal);
    const rejected = assert.rejects(result, /abort/i);
    if (drawFirstSlice) { t.mock.timers.tick(0); await flush(); }
    task.abort(); t.mock.timers.tick(0); await rejected;
  }
});

test('viewport rendering clips coverage and samples the same numeric cells at pixel centers after zoom', () => {
  const manifest = gridFixture('clouds').manifest;
  const [w, s, e, n] = manifest.grid.bounds;
  const north = Math.log(Math.tan(Math.PI / 4 + n * Math.PI / 360));
  const south = Math.log(Math.tan(Math.PI / 4 + s * Math.PI / 360));
  const map = { getBounds: () => ({ getWest: () => w - 1, getEast: () => e + 1, getSouth: () => s - 1, getNorth: () => n + 1 }),
    project: ([lon, lat]: [number, number]) => ({ x: (lon - w) / (e - w) * 80, y: (north - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))) / (north - south) * 60 }),
  } as unknown as MapLibreMap;
  const view = gridViewport(map, manifest)!;
  assert.deepEqual(view.bounds, manifest.grid.bounds);
  assert.equal(view.width, 80); assert.equal(view.height, 60);
  for (const [x, y] of [[0, 0], [79, 59], [15, 20], [40, 30]]) {
    const lon: number = w + (x! + .5) / view.width * (e - w);
    const lat: number = Math.atan(Math.sinh(north - (y! + .5) / view.height * (north - south))) * 180 / Math.PI;
    assert.equal(view.rows[y!]! + view.columns[x!]!, gridCell(manifest, lon, lat));
  }
  const outside = { ...map, getBounds: () => ({ getWest: () => 0, getEast: () => 10, getSouth: () => 10, getNorth: () => 20 }) } as unknown as MapLibreMap;
  assert.equal(gridViewport(outside, manifest), undefined);
});

test('camera movement retains the applicable image; new times clear it until ready and cached back-steps reject canceled draws', async t => {
  const fixture = gridFixture('clouds'), frame = fixture.manifest.frames[1]!;
  const data = await decodeGrid(bytes(fixture.files[frame.path]!), fixture.manifest, frame, signal());
  const state: Pick<ReturnType<WeatherController['getSnapshot']>, 'grid' | 'preferences' | 'gridDisplay' | 'gridRenderError' | 'forecastRetry' | 'selectedTime' | 'now'> = {
    selectedTime: null, now: WEATHER_NOW, forecastRetry: 0,
    preferences: weatherAwcPreferences.select({ awcEnabled: true, awcGridMode: 'cloudCover' }),
    grid: { data, loading: false, products: { clouds: { loading: false }, icing: { loading: false }, winds: { loading: false } } },
  };
  const displayedTime = () => state.gridDisplay?.data.frame.validTime;
  let probe: Parameters<WeatherController['setLocator']>[0], writes = 0, projections = 0, opacityWrites = 0;
  const canvas = { width: 0, height: 0, getContext: () => ({ putImageData() { writes++; } }) };
  for (const [name, value] of Object.entries({ document: { createElement: () => canvas },
    ImageData: class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name); });
  }
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = { getSnapshot: () => state, setLocator(value: typeof probe) { probe = value; },
    setForecastInteraction() {},
    setGridDisplay(value: typeof state.gridDisplay) { state.gridDisplay = value; },
    setGridRenderError(error: string | undefined) { state.gridRenderError = error; },
  } as unknown as WeatherController;
  let bounds = [-110, 30, -80, 45], layer: { visibility?: string } | undefined, source: object | undefined;
  let denyLayer = true;
  const visibility = () => layer?.visibility;
  const events = new Map<string, () => void>();
  const map = {
    getBounds: () => ({ getWest: () => bounds[0], getSouth: () => bounds[1], getEast: () => bounds[2], getNorth: () => bounds[3] }),
    project: ([x, y]: number[]) => { projections++; return { x, y }; }, unproject: (point: number[]) => ({ lng: point[0], lat: point[1] }),
    getLayer: () => layer, getSource: () => source,
    addLayer() { if (denyLayer) throw new Error('Map layer failed'); layer = {}; }, addSource() { source = { updateImage() {} }; },
    removeLayer() { layer = undefined; }, removeSource() { source = undefined; },
    setPaintProperty() { opacityWrites++; }, setLayoutProperty(_id: string, _key: string, value: string) { layer!.visibility = value; },
    on(event: string, action: () => void) { events.set(event, action); }, off(event: string) { events.delete(event); },
    once() {}, triggerRepaint() {},
  } as unknown as MapLibreMap;
  const renderer = mountGridMap(map, controller, 'weather'); t.after(() => renderer.destroy());
  const finish = async (ready: () => boolean = () => true) => {
    const deadline = Date.now() + 5000;
    for (let i = 0; i < 3 || !ready(); i++) {
      assert.ok(Date.now() < deadline, 'renderer must settle'); t.mock.timers.tick(0); await flush();
    }
  };
  renderer.update(); await finish(() => !!state.gridRenderError);
  assert.equal(state.gridRenderError, 'Map layer failed');
  assert.ok(source); assert.equal(layer, undefined, 'partial map setup can be retried');
  renderer.update(); renderer.update(); await finish();
  assert.equal(writes, 1, 'ordinary status updates do not loop on a failed draw');
  denyLayer = false; state.forecastRetry++; renderer.update(); await finish(() => visibility() === 'visible');
  assert.equal(state.gridRenderError, undefined);
  assert.equal(visibility(), 'visible'); assert.equal(writes, 2);
  const initialProjections = projections;
  state.forecastRetry++;
  renderer.update(); renderer.update(); await finish();
  assert.equal(projections, initialProjections, 'status and point updates reuse the sampled viewport');
  assert.equal(writes, 2, 'retrying another forecast does not redraw a healthy layer'); assert.equal(opacityWrites, 0);
  state.preferences.awcGridOpacity = 0.5; renderer.update(); renderer.update(); await finish();
  assert.equal(writes, 2, 'opacity changes do not recolor the forecast'); assert.equal(opacityWrites, 1);
  events.get('movestart')!();
  bounds = [-120, 25, -70, 46]; events.get('moveend')!();
  assert.equal(visibility(), 'visible', 'zoom/pan keeps the previous raster visible while sampling');
  assert.ok(probe?.({ x: -95, y: 38 }), 'inspection remains usable in the displayed image');
  assert.ok(probe?.({ x: -115, y: 38 }), 'new viewport areas use the committed forecast without waiting for pixels');
  for (const x of [245, -475, 605]) {
    assert.deepEqual(probe?.({ x, y: 38 }), { longitude: -115, latitude: 38 }, 'world copies inspect the same canonical forecast cell');
  }
  assert.equal(probe?.({ x: 230, y: 38 }), undefined, 'wrapping still respects the forecast domain');
  assert.equal(probe?.({ x: -130, y: 38 }), undefined, 'inspection still respects the forecast domain');
  bounds = [-121, 24, -69, 47]; events.get('resize')!();
  await finish();
  assert.equal(writes, 2, 'unhatched full-domain imagery needs no camera redraw or texture upload');
  assert.ok(probe?.({ x: -115, y: 38 }));
  state.preferences.awcGridMode = 'cloudBase'; renderer.update();
  assert.equal(visibility(), 'none'); assert.equal(probe?.({ x: -95, y: 38 }), undefined);
  await finish(() => state.gridDisplay?.mode === 'cloudBase'); assert.equal(visibility(), 'visible');
  state.selectedTime = frame.validTime + 3600000; renderer.update();
  assert.equal(visibility(), 'none', 'the new tick hides old data before acquisition reconciliation');
  assert.equal(state.gridDisplay, undefined);
  assert.equal(probe?.({ x: -95, y: 38 }), undefined);
  state.grid.data = undefined; state.grid.loading = true; renderer.update();
  assert.equal(visibility(), 'none', 'downloading never uses the previous tick as a placeholder');
  state.grid.loading = false;
  const next = { ...data, frame: { ...frame, validTime: frame.validTime + 3600000 } };
  state.grid.data = next; renderer.update();
  assert.equal(visibility(), 'none', 'the new frame remains hidden until its own pixels are ready');
  assert.equal(state.gridDisplay, undefined);
  state.selectedTime = frame.validTime; state.grid.data = data; renderer.update();
  assert.equal(visibility(), 'visible', 'cached back-stepping restores a hidden texture immediately');
  assert.equal(displayedTime(), frame.validTime);
  await finish();
  assert.equal(displayedTime(), frame.validTime, 'the canceled next-frame draw cannot regain the display');
  state.selectedTime = next.frame.validTime; state.grid.data = next; renderer.update();
  assert.equal(visibility(), 'none');
  await finish(() => displayedTime() === next.frame.validTime);
  assert.equal(displayedTime(), next.frame.validTime);
  bounds = [-120, 25, -70, 46]; events.get('moveend')!();
  state.preferences.awcEnabled = false; renderer.update(); await finish();
  assert.equal(layer, undefined); assert.equal(source, undefined); assert.equal(probe?.({ x: -95, y: 38 }), undefined);
  assert.equal(state.gridDisplay, undefined);
  assert.equal(canvas.width, 0, 'disabling releases the image and cancels the pending redraw');
});

test('client isolates endpoint identity, rejects future publications and corrupt transfers, and tolerates denied persistence', async t => {
  const fixture = gridFixture('clouds'), values = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousCache = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  t.after(() => { if (previousCache) Object.defineProperty(globalThis, 'caches', previousCache); else Reflect.deleteProperty(globalThis, 'caches'); });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: {
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value),
  } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); });
  let body: unknown = fixture.manifest, corrupt = false;
  t.mock.method(globalThis, 'fetch', async (input: string, options: RequestInit) => {
    assert.equal(options.cache, 'no-store');
    const path = new URL(input).pathname;
    if (path.endsWith('.json')) return Response.json(body);
    const frame = fixture.manifest.frames.find(f => path.endsWith(f.path))!;
    const raw = bytes(fixture.files[frame.path]!);
    return new Response(corrupt ? new Uint8Array(raw.byteLength).buffer : raw);
  });
  const client = new GridClient('https://app.test/');
  const manifest = await client.refresh('clouds', signal());
  assert.equal(client.remember(manifest), true);
  assert.equal(client.restore('clouds').manifest?.generation, manifest.generation);
  assert.equal(new GridClient('https://other.test/').restore('clouds').manifest, undefined);
  body = { ...fixture.manifest, publishedAt: Date.now() + 120_000 };
  await assert.rejects(client.refresh('clouds', signal()), /clock mismatch/);
  assert.equal(client.restore('clouds').manifest?.publishedAt, manifest.publishedAt);
  corrupt = true;
  await assert.rejects(client.load(manifest, manifest.frames[1]!, signal(), true), /checksum/);
  corrupt = false;
  Object.defineProperty(globalThis, 'caches', { configurable: true, get() { throw new Error('CacheStorage denied'); } });
  const data = await client.load(manifest, manifest.frames[1]!, signal(), true);
  assert.equal(gridValue(data, 'cloudCover', 0), 75);
  await assert.rejects(client.load(manifest, manifest.frames[2]!, signal(), false), /not saved/);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { get localStorage() { throw new Error('denied'); } } });
  body = fixture.manifest;
  assert.equal(client.remember(manifest), false);
  assert.equal((await client.refresh('clouds', signal())).generation, manifest.generation);
});

test('grid demand skips gaps and rejects late old-altitude results, retries offline recovery and detaches cleanly', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: WEATHER_NOW });
  const manifest = gridFixture('icing').manifest;
  const pending: { resolve: (data: Awaited<ReturnType<GridClient['load']>>) => void; frame: Parameters<GridClient['load']>[1]; signal: AbortSignal }[] = [];
  const client = new GridClient('https://app.test/');
  t.mock.method(client, 'restore', (product: string) => ({ loading: false, ...(product === 'icing' ? { manifest } : {}) }));
  t.mock.method(client, 'refresh', async () => manifest);
  t.mock.method(client, 'load', (_m: Parameters<GridClient['load']>[0], frame: Parameters<GridClient['load']>[1], signal: AbortSignal) => new Promise(resolve => pending.push({ resolve, frame, signal })));
  rememberLoadedFrames(t, client);
  const controller = createGridController(client, () => {}); t.after(() => controller.detach());
  const input = { enabled: true, mode: 'icingProbability' as const, altitude: 8000, time: WEATHER_NOW, online: false, visible: true };
  controller.configure(input); controller.attach();
  assert.deepEqual(gridTimes(controller.getSnapshot(), input.mode, 8000), [WEATHER_NOW, WEATHER_NOW + 3600000, WEATHER_NOW + 10800000]);
  assert.equal(pending.length, 1);
  controller.configure({ ...input, altitude: 12000 });
  assert.equal(pending[0]!.signal.aborted, true);
  pending[0]!.resolve({ manifest, frame: pending[0]!.frame, values: new Float32Array(144), byteLength: 592 }); await flush();
  assert.equal(controller.getSnapshot().data, undefined);
  pending[1]!.resolve({ manifest, frame: pending[1]!.frame, values: new Float32Array(144), byteLength: 592 }); await flush();
  assert.equal(controller.getSnapshot().data?.frame.altitudeFtMsl, 12000);
  const displayed = controller.getSnapshot().data;
  const acquiring = pending.length;
  controller.configure({ ...input, altitude: 12000, time: WEATHER_NOW + 20 * 60_000 });
  assert.equal(controller.getSnapshot().data, displayed, 'another product changing between grid times retains the applicable grid');
  assert.equal(pending.length, acquiring, 'an unchanged grid does not acquire or decode again');
  assert.equal(controller.getSnapshot().loading, false);
  controller.configure({ ...input, time: WEATHER_NOW + 7200000 });
  assert.equal(controller.getSnapshot().data, undefined, 'no interpolation across a missing forecast hour');
  assert.equal(controller.getSnapshot().loading, false);
  controller.configure({ ...input, online: false });
  const offline = pending.at(-1)!;
  controller.configure({ ...input, online: true });
  assert.equal(offline.signal.aborted, true, 'reconnect changes acquisition identity');
  controller.detach(); assert.ok(pending.at(-1)!.signal.aborted);
  assert.equal(controller.getSnapshot().data, undefined);
});

for (const product of ['clouds', 'icing', 'winds'] as const) test(`${product} selection displays first and warmed Next commits while the remaining timeline saves`, async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: WEATHER_NOW });
  const manifest = gridFixture(product).manifest;
  type Loaded = Awaited<ReturnType<GridClient['load']>>;
  const pending: { frame: Loaded['frame']; signal: AbortSignal; resolve(data: Loaded): void }[] = [];
  const client = new GridClient('https://app.test/');
  t.mock.method(client, 'restore', () => ({ loading: false, manifest }));
  t.mock.method(client, 'load', (_manifest: Loaded['manifest'], frame: Loaded['frame'], signal: AbortSignal) =>
    new Promise<Loaded>(resolve => pending.push({ frame, signal, resolve })));
  rememberLoadedFrames(t, client);
  const controller = createGridController(client, () => {}, [product]); t.after(() => controller.detach());
  const input = { enabled: true, mode: product === 'winds' ? 'temperature' as const : product === 'icing' ? 'icingProbability' as const : 'cloudCover' as const,
    altitude: product === 'winds' ? 5000 : 8000, time: WEATHER_NOW, online: true, visible: true };
  const finish = async (index: number) => {
    const job = pending[index]!;
    job.resolve({ manifest, frame: job.frame, values: new Float32Array(240), byteLength: 976 }); await flush();
  };
  controller.configure(input); controller.attach();
  assert.equal(pending.length, 1, 'background frames wait for selected data to become usable');
  assert.equal(pending[0]!.frame.validTime, WEATHER_NOW);
  await finish(0);
  assert.equal(controller.getSnapshot().data?.frame.validTime, WEATHER_NOW, 'later times cannot delay the selection');
  assert.deepEqual(controller.getSnapshot().preparation, { ready: 1, total: 3, failed: 0 });
  await finish(1);
  const count = pending.length;
  controller.configure({ ...input, time: WEATHER_NOW + 3600000 });
  assert.equal(controller.getSnapshot().data?.frame.validTime, WEATHER_NOW + 3600000, 'warmed data is committed synchronously');
  assert.equal(controller.getSnapshot().loading, false);
  assert.equal(pending.length, count, 'a warmed selection has no second decode');
  await finish(2);
  assert.deepEqual(controller.getSnapshot().preparation, { ready: 3, total: 3, failed: 0 });
  controller.configure({ ...input, online: false });
  assert.equal(controller.getSnapshot().preparation, undefined);
});

test('wind selection displays before adjacent forecasts complete and altitude changes reject late old-level work', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: WEATHER_NOW });
  const manifest = gridFixture('winds').manifest;
  type Loaded = Awaited<ReturnType<GridClient['load']>>;
  const pending: { frame: Loaded['frame']; signal: AbortSignal; resolve(data: Loaded): void }[] = [];
  const client = new GridClient('https://app.test/');
  t.mock.method(client, 'restore', () => ({ loading: false, manifest }));
  t.mock.method(client, 'refresh', async () => manifest);
  t.mock.method(client, 'load', (_manifest: Loaded['manifest'], frame: Loaded['frame'], signal: AbortSignal) =>
    new Promise<Loaded>(resolve => pending.push({ frame, signal, resolve })));
  rememberLoadedFrames(t, client);
  const controller = createGridController(client, () => {}, ['winds']); t.after(() => controller.detach());
  const input = { enabled: true, mode: 'temperature' as const, altitude: 5000, time: WEATHER_NOW, online: true, visible: true, prepareTimeline: false };
  const finish = async (job: typeof pending[number]) => {
    job.resolve({ manifest, frame: job.frame, values: new Float32Array(192), byteLength: 784 }); await flush();
  };
  controller.configure(input); controller.attach(); t.mock.timers.tick(0); await flush();
  assert.equal(pending.length, 1, 'speculative work cannot race the selected acquisition');
  assert.equal(pending[0]!.frame.validTime, WEATHER_NOW, 'selection has priority over speculative times');
  await finish(pending[0]!);
  assert.equal(pending[1]!.frame.validTime, WEATHER_NOW + 3600000);
  assert.equal(controller.getSnapshot().data?.frame.altitudeFtMsl, 5000, 'slow adjacent times cannot hold the selection hostage');
  assert.equal(controller.getSnapshot().loading, false);
  assert.deepEqual(controller.getSnapshot().preparation, { ready: 1, total: 2, failed: 0 }, 'barbs expose progress for their neighborhood without gating display');
  const oldJobs = pending.slice(1);
  controller.configure({ ...input, altitude: 10000 });
  assert.ok(oldJobs.every(job => job.signal.aborted));
  const selected = pending.find(job => job.frame.altitudeFtMsl === 10000 && job.frame.validTime === WEATHER_NOW)!;
  assert.ok(selected);
  for (const old of oldJobs) await finish(old);
  assert.equal(controller.getSnapshot().data, undefined, 'old-altitude replies cannot regain the display');
  await finish(selected);
  assert.equal(controller.getSnapshot().data?.frame.altitudeFtMsl, 10000);
});

test('temperature expands barb preparation without reloading the selection, cancels distant work on disable, and retries failures', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: WEATHER_NOW });
  const manifest = gridFixture('winds').manifest, client = new GridClient('https://app.test/');
  type Loaded = Awaited<ReturnType<GridClient['load']>>;
  const pending: { frame: Loaded['frame']; signal: AbortSignal; resolve(data: Loaded): void; reject(error: Error): void }[] = [];
  t.mock.method(client, 'restore', () => ({ loading: false, manifest }));
  t.mock.method(client, 'load', (_manifest: Loaded['manifest'], frame: Loaded['frame'], signal: AbortSignal) =>
    new Promise<Loaded>((resolve, reject) => pending.push({ frame, signal, resolve, reject })));
  rememberLoadedFrames(t, client);
  t.mock.method(client, 'prepare', async (...args: Parameters<GridClient['load']>) => { await client.load(...args); return true; });
  const controller = createGridController(client, () => {}, ['winds']); t.after(() => controller.detach());
  const input = { enabled: true, mode: 'temperature' as const, altitude: 5000, time: WEATHER_NOW,
    online: true, visible: true, prepareTimeline: false };
  const finish = async (job: typeof pending[number]) => {
    job.resolve({ manifest, frame: job.frame, values: new Float32Array(192), byteLength: 784 }); await flush();
  };
  controller.configure(input); controller.attach();
  await finish(pending[0]!); await finish(pending[1]!);
  const displayed = controller.getSnapshot().data;
  assert.deepEqual(controller.getSnapshot().preparation, { ready: 2, total: 2, failed: 0 });
  controller.configure({ ...input, prepareTimeline: true }); await flush();
  assert.equal(pending[2]!.frame.validTime, WEATHER_NOW + 10800000, 'temperature saves the distant selected-altitude time');
  assert.equal(controller.getSnapshot().data, displayed);
  assert.deepEqual(controller.getSnapshot().preparation, { ready: 2, total: 3, failed: 0 });
  controller.configure(input);
  assert.equal(pending[2]!.signal.aborted, true);
  await finish(pending[2]!);
  assert.deepEqual(controller.getSnapshot().preparation, { ready: 2, total: 2, failed: 0 }, 'a cancelled reply cannot change the smaller preparation scope');
  controller.configure({ ...input, prepareTimeline: true }); await flush();
  pending[3]!.reject(new Error('Temperature source outage')); await flush();
  assert.deepEqual(controller.getSnapshot().preparation, { ready: 2, total: 3, failed: 1, error: 'Temperature source outage' });
  assert.equal(controller.getSnapshot().data, displayed, 'a background failure preserves the usable selection');
  controller.retry(); await flush(); await finish(pending[4]!);
  assert.deepEqual(controller.getSnapshot().preparation, { ready: 3, total: 3, failed: 0 });
  assert.equal(pending.filter(job => job.frame.validTime === WEATHER_NOW).length, 1);
  const completed = pending.length;
  controller.configure(input);
  controller.configure({ ...input, prepareTimeline: true }); await flush();
  assert.deepEqual(controller.getSnapshot().preparation, { ready: 3, total: 3, failed: 0 }, 'returning to temperature retains completed distant saves');
  assert.equal(pending.length, completed, 'shrinking the barb scope does not force the saved horizon through preparation again');
});

test('evicted horizon receipts become incomplete without a download loop and explicit retry repairs them', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: WEATHER_NOW });
  const manifest = gridFixture('clouds').manifest, client = new GridClient('https://app.test/');
  const retained = new Set(manifest.frames.map(frame => gridKey(manifest, frame)));
  let notify = () => {};
  t.mock.method(client, 'subscribeFiles', (listener: () => void) => { notify = listener; return () => { notify = () => {}; }; });
  t.mock.method(client, 'restore', () => ({ loading: false, manifest }));
  t.mock.method(client, 'refresh', async () => manifest);
  t.mock.method(client, 'load', async (...args: Parameters<GridClient['load']>) => ({ manifest, frame: args[1], values: new Float32Array(192), byteLength: 784 }));
  rememberLoadedFrames(t, client);
  t.mock.method(client, 'checkSaved', async (...args: Parameters<GridClient['checkSaved']>) => args[1].map(frame => retained.has(gridKey(manifest, frame))));
  const prepare = t.mock.method(client, 'prepare', async (...args: Parameters<GridClient['prepare']>) => {
    await client.load(...args); retained.add(gridKey(manifest, args[1])); return true;
  });
  const controller = createGridController(client, () => {}); t.after(() => controller.detach());
  const input = { enabled: true, mode: 'cloudCover' as const, altitude: 0, time: WEATHER_NOW, online: true, visible: true };
  controller.configure(input); controller.attach(); t.mock.timers.tick(0); await flush();
  assert.deepEqual(controller.getSnapshot().preparation, { ready: 3, total: 3, failed: 0 });
  const before = prepare.mock.callCount(), displayed = controller.getSnapshot().data;
  const distant = manifest.frames.find(frame => frame.validTime === WEATHER_NOW + 3 * 3600000)!;
  retained.delete(gridKey(manifest, distant)); notify(); t.mock.timers.tick(250); await flush();
  assert.deepEqual(controller.getSnapshot().preparation, { ready: 2, total: 3, failed: 0, limited: true });
  assert.equal(controller.getSnapshot().data, displayed);
  controller.configure({ ...input, time: WEATHER_NOW + 60_000 }); t.mock.timers.tick(60_250); await flush();
  assert.equal(prepare.mock.callCount(), before, 'inventory loss alone cannot continuously refill an undersized cache');
  controller.retry(); await flush();
  assert.deepEqual(controller.getSnapshot().preparation, { ready: 3, total: 3, failed: 0 });
  assert.equal(prepare.mock.callCount(), before + 1);
  // Settle the explicit retry's catalog refresh before advancing inventory timers.
  t.mock.timers.tick(0); await flush();
  t.mock.timers.tick(250); await flush();
  retained.delete(gridKey(manifest, distant)); // Simulate silent browser eviction.
  t.mock.timers.tick(60_001);
  controller.configure({ ...input, time: WEATHER_NOW + 60_000 });
  t.mock.timers.tick(250); await flush();
  assert.equal(controller.getSnapshot().preparation?.limited, true, 'unchanged pinned-hour inputs still reconcile inventory');
});

test('an inventory result cannot undo a newer receipt obtained while selecting another hour', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: WEATHER_NOW });
  const manifest = gridFixture('clouds').manifest, client = new GridClient('https://app.test/');
  t.mock.method(client, 'restore', () => ({ loading: false, manifest }));
  t.mock.method(client, 'refresh', async () => manifest);
  t.mock.method(client, 'load', async (_manifest: typeof manifest, frame: typeof manifest.frames[number]) =>
    ({ manifest, frame, values: new Float32Array(240), byteLength: 976 }));
  rememberLoadedFrames(t, client);
  t.mock.method(client, 'prepare', async (...args: Parameters<GridClient['prepare']>) => { await client.load(...args); return true; });
  let notify = () => {};
  t.mock.method(client, 'subscribeFiles', (listener: () => void) => { notify = listener; return () => {}; });
  const controller = createGridController(client, () => {}, ['clouds']); t.after(() => controller.detach());
  const input = { enabled: true, mode: 'cloudCover' as const, altitude: 0, time: WEATHER_NOW, online: true, visible: true };
  controller.configure(input); controller.attach(); t.mock.timers.tick(0); await flush();
  t.mock.timers.tick(250); await flush();
  assert.deepEqual(controller.getSnapshot().preparation, { ready: 3, total: 3, failed: 0 });
  const distant = WEATHER_NOW + 3 * 3600000;
  let finish!: () => void;
  t.mock.method(client, 'checkSaved', (_manifest: typeof manifest, frames: typeof manifest.frames) =>
    new Promise<boolean[]>(resolve => { finish = () => resolve(frames.map(frame => frame.validTime !== distant)); }));
  notify(); t.mock.timers.tick(250); await flush();
  // Reading the distant hour produces a newer successful receipt with the same
  // saved=true value; the inventory request still describes its preceding save.
  controller.configure({ ...input, time: distant }); await flush();
  assert.equal(controller.getSnapshot().data?.frame.validTime, distant);
  controller.configure(input); await flush();
  finish(); await flush();
  assert.deepEqual(controller.getSnapshot().preparation, { ready: 3, total: 3, failed: 0 });
  assert.equal(controller.getSnapshot().data?.frame.validTime, WEATHER_NOW);
});

test('a late inventory read cannot erase the real client receipt of a repaired file', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: WEATHER_NOW });
  const fixture = gridFixture('clouds'), manifest = fixture.manifest, frame = manifest.frames[1]!;
  const { cache, stored } = cacheFixture(t, 'zlayers-plugin-files-v1:weather-awc:grids');
  const client = new GridClient('https://receipt-repair.test/');
  t.after(() => client.neighborhood('clouds'));
  t.mock.method(globalThis, 'fetch', async () => new Response(bytes(fixture.files[frame.path]!)));
  client.neighborhood('clouds', manifest, [frame]);
  const data = await client.load(manifest, frame, signal(), true);
  assert.equal(client.saved(data), true);
  stored.clear();
  assert.deepEqual(await client.checkSaved(manifest, [frame], signal()), [false]);
  assert.equal(client.saved(data), false);
  const keys = cache.keys.bind(cache);
  let release!: () => void, started!: () => void, held = false;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  t.mock.method(cache, 'keys', async (...args: Parameters<typeof keys>) => {
    const snapshot = await keys(...args);
    if (!held) { held = true; started(); await blocked; }
    return snapshot;
  });
  const oldInventory = client.checkSaved(manifest, [frame], signal());
  await waiting;
  assert.equal(await client.prepare(manifest, frame, signal(), true), true);
  assert.equal(client.saved(data), true);
  release();
  assert.deepEqual(await oldInventory, [true], 'a newer save supersedes the old missing-file observation');
  assert.equal(client.saved(data), true);
});

test('forecast freshness agrees across toolbox and inspection, including clock rollback and stale browser checks', () => {
  const manifest = gridFixture('winds').manifest, record = { loading: false, manifest, checkedAt: WEATHER_NOW };
  assert.equal(forecastIsStale(record, manifest, WEATHER_NOW, false), false);
  assert.equal(forecastIsStale(record, manifest, WEATHER_NOW, true), true);
  assert.equal(forecastIsStale(record, manifest, WEATHER_NOW + 10 * 60_000 + 1, false), true);
  assert.equal(forecastIsStale({ ...record, checkedAt: WEATHER_NOW + 1 }, manifest, WEATHER_NOW, false), true);
  assert.equal(forecastIsStale(record, { ...manifest, checkedAt: WEATHER_NOW + 1 }, WEATHER_NOW, false), true);
  assert.equal(forecastIsStale({ ...record, error: 'Refresh failed' }, manifest, WEATHER_NOW, false), true);
});

for (const product of ['icing', 'winds'] as const) test(`${product} without the selected altitude has no perpetual preparation indicator`, t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: WEATHER_NOW });
  const manifest = gridFixture(product).manifest, client = new GridClient('https://app.test/');
  t.mock.method(client, 'restore', () => ({ loading: false, manifest }));
  const load = t.mock.method(client, 'load', () => { throw new Error('No frame should load'); });
  const controller = createGridController(client, () => {}, [product]); t.after(() => controller.detach());
  controller.configure({ enabled: true, mode: product === 'winds' ? 'temperature' : 'icingProbability',
    altitude: 18000, time: WEATHER_NOW, online: true, visible: true });
  controller.attach();
  assert.equal(controller.getSnapshot().data, undefined);
  assert.equal(controller.getSnapshot().loading, false);
  assert.equal(controller.getSnapshot().preparation, undefined);
  assert.equal(load.mock.callCount(), 0);
});

test('a stalled forecast expires and retries on its own without changing time or altitude', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: WEATHER_NOW });
  const source = gridFixture('winds').manifest;
  const manifest = { ...source, frames: source.frames.filter(frame => frame.pressureHpa === 850 && frame.validTime === WEATHER_NOW) };
  type Loaded = Awaited<ReturnType<GridClient['load']>>;
  const pending: { frame: Loaded['frame']; signal: AbortSignal; resolve(data: Loaded): void }[] = [];
  const client = new GridClient('https://app.test/');
  t.mock.method(client, 'restore', () => ({ loading: false, manifest }));
  t.mock.method(client, 'refresh', async () => manifest);
  t.mock.method(client, 'load', (_manifest: Loaded['manifest'], frame: Loaded['frame'], signal: AbortSignal) =>
    new Promise<Loaded>(resolve => pending.push({ frame, signal, resolve })));
  rememberLoadedFrames(t, client);
  const controller = createGridController(client, () => {}, ['winds']); t.after(() => controller.detach());
  controller.configure({ enabled: true, mode: 'temperature', altitude: 5000, time: WEATHER_NOW, online: true, visible: true });
  controller.attach(); t.mock.timers.tick(0); await flush();
  t.mock.timers.tick(60_000); await flush();
  assert.equal(pending[0]!.signal.aborted, true);
  assert.equal(controller.getSnapshot().error, 'Forecast loading timed out');
  assert.equal(controller.getSnapshot().loading, false);
  t.mock.timers.tick(59_999); await flush(); assert.equal(pending.length, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(pending.length, 2, 'retry has its own timer');
  const selected = pending[1]!;
  selected.resolve({ manifest, frame: selected.frame, values: new Float32Array(192), byteLength: 784 }); await flush();
  assert.equal(controller.getSnapshot().error, undefined);
  assert.equal(controller.getSnapshot().data?.frame.altitudeFtMsl, 5000);
});

test('a failed preparation leaves other forecasts usable and retries after backoff', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: WEATHER_NOW });
  const manifest = gridFixture('clouds').manifest;
  type Loaded = Awaited<ReturnType<GridClient['load']>>;
  const pending: { frame: Loaded['frame']; resolve(data: Loaded): void; reject(error: Error): void }[] = [];
  const client = new GridClient('https://app.test/');
  t.mock.method(client, 'restore', (product: string) => ({ loading: false, ...(product === 'clouds' ? { manifest } : {}) }));
  t.mock.method(client, 'refresh', async (product: 'clouds' | 'icing') => gridFixture(product).manifest);
  t.mock.method(client, 'load', (_manifest: Loaded['manifest'], frame: Loaded['frame']) =>
    new Promise<Loaded>((resolve, reject) => pending.push({ frame, resolve, reject })));
  rememberLoadedFrames(t, client);
  const controller = createGridController(client, () => {}); t.after(() => controller.detach());
  const input = { enabled: true, mode: 'cloudCover' as const, altitude: 8000, time: WEATHER_NOW, online: true, visible: true };
  const finish = async (index: number) => {
    const job = pending[index]!;
    job.resolve({ manifest, frame: job.frame, values: new Float32Array(240), byteLength: 976 }); await flush();
  };
  controller.configure(input); controller.attach(); await finish(0);
  pending[1]!.reject(new Error('Source outage')); await flush(); await finish(2);
  assert.equal(controller.getSnapshot().data?.frame.validTime, WEATHER_NOW, 'a failed background frame does not hide the usable selection');
  assert.equal(controller.getSnapshot().error, undefined, 'background failure does not replace the displayed forecast with an error');
  assert.deepEqual(controller.getSnapshot().preparation, { ready: 2, total: 3, failed: 1, error: 'Source outage' });
  controller.configure(input);
  assert.equal(pending.length, 3, 'failed preparation does not spin in a retry loop');
  t.mock.timers.tick(60_000); await flush(); controller.configure(input);
  assert.equal(pending[3]!.frame.validTime, WEATHER_NOW + 3600000);
  await finish(3);
  assert.equal(controller.getSnapshot().data?.frame.validTime, WEATHER_NOW);
  assert.deepEqual(controller.getSnapshot().preparation, { ready: 3, total: 3, failed: 0 });
  controller.configure({ ...input, time: WEATHER_NOW + 3600000 });
  assert.equal(controller.getSnapshot().data?.frame.validTime, WEATHER_NOW + 3600000);
  assert.equal(pending.filter(job => job.frame.validTime === WEATHER_NOW + 3600000).length, 2, 'the successfully retried neighbor needs no third decode');
});

test('source pointer advances after the selected replacement loads while other times continue saving', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: WEATHER_NOW });
  type Loaded = Awaited<ReturnType<GridClient['load']>>;
  const original = gridFixture('clouds').manifest, replacement = gridFixture('clouds', 2).manifest;
  let catalog = original;
  const pending: { manifest: Loaded['manifest']; frame: Loaded['frame']; resolve(data: Loaded): void }[] = [];
  const client = new GridClient('https://app.test/');
  t.mock.method(client, 'restore', () => ({ loading: false, manifest: original }));
  t.mock.method(client, 'refresh', async () => catalog);
  t.mock.method(client, 'load', (manifest: Loaded['manifest'], frame: Loaded['frame']) =>
    new Promise<Loaded>(resolve => pending.push({ manifest, frame, resolve })));
  rememberLoadedFrames(t, client);
  const remembered = t.mock.method(client, 'remember', () => true);
  const controller = createGridController(client, () => {}, ['clouds']); t.after(() => controller.detach());
  const finish = async (job: typeof pending[number]) => {
    job.resolve({ manifest: job.manifest, frame: job.frame, values: new Float32Array(240), byteLength: 976 }); await flush();
  };
  controller.configure({ enabled: true, mode: 'cloudCover', altitude: 8000, time: WEATHER_NOW, online: true, visible: true });
  controller.attach(); t.mock.timers.tick(0); await flush();
  for (let i = 0; i < 3; i++) await finish(pending[i]!);
  catalog = replacement; t.mock.timers.tick(300_000); await flush();
  assert.equal(controller.getSnapshot().products.clouds.manifest, original);
  assert.equal(remembered.mock.calls.some(call => call.arguments[0] === replacement), false);
  const selected = pending.find(job => job.manifest === replacement && job.frame.validTime === WEATHER_NOW)!;
  assert.ok(selected); await finish(selected);
  assert.equal(controller.getSnapshot().data?.manifest, replacement);
  assert.equal(controller.getSnapshot().products.clouds.manifest, replacement);
  assert.equal(remembered.mock.calls.some(call => call.arguments[0] === replacement), true);
  assert.ok(controller.getSnapshot().preparation!.ready < controller.getSnapshot().preparation!.total);
});

test('a refreshed catalog that drops the pinned time advances after validating a current frame', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: WEATHER_NOW });
  const original = gridFixture('clouds').manifest, replacement = gridFixture('clouds', 2).manifest;
  replacement.frames = replacement.frames.filter(frame => frame.validTime > WEATHER_NOW);
  let catalog = original;
  type Loaded = Awaited<ReturnType<GridClient['load']>>;
  const pending: { manifest: Loaded['manifest']; frame: Loaded['frame']; resolve(data: Loaded): void }[] = [];
  const client = new GridClient('https://app.test/');
  t.mock.method(client, 'restore', () => ({ loading: false, manifest: original }));
  t.mock.method(client, 'refresh', async () => catalog);
  t.mock.method(client, 'load', (manifest: Loaded['manifest'], frame: Loaded['frame']) =>
    new Promise<Loaded>(resolve => pending.push({ manifest, frame, resolve })));
  rememberLoadedFrames(t, client);
  const controller = createGridController(client, () => {}, ['clouds']); t.after(() => controller.detach());
  const input = { enabled: true, mode: 'cloudCover' as const, altitude: 8000, time: WEATHER_NOW, online: true, visible: true };
  const finish = async (job: typeof pending[number]) => {
    job.resolve({ manifest: job.manifest, frame: job.frame, values: new Float32Array(240), byteLength: 976 }); await flush();
  };
  controller.configure(input); controller.attach(); t.mock.timers.tick(0); await flush();
  for (let i = 0; i < 3; i++) await finish(pending[i]!);
  catalog = replacement; t.mock.timers.tick(3600000); await flush();
  assert.equal(controller.getSnapshot().products.clouds.manifest, original, 'the saved catalog waits for validated replacement data');
  const current = pending.find(job => job.manifest === replacement && job.frame.validTime === WEATHER_NOW + 3600000)!;
  assert.ok(current); await finish(current);
  assert.equal(controller.getSnapshot().products.clouds.manifest, replacement);
  assert.equal(controller.getSnapshot().data, undefined, 'warming Now cannot display it under the unavailable pinned time');
  controller.configure({ ...input, time: WEATHER_NOW + 3600000 });
  assert.equal(controller.getSnapshot().data?.manifest, replacement);
  assert.equal(controller.getSnapshot().loading, false, 'the validated current frame is already warm');
});

test('catalog demand follows the selected product without waiting for an unrelated family', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: WEATHER_NOW });
  const client = new GridClient('https://app.test/');
  t.mock.method(client, 'restore', () => ({ loading: false }));
  const pending: { product: string; signal: AbortSignal; finish: () => void; fail: () => void }[] = [];
  t.mock.method(client, 'refresh', (product: 'clouds' | 'icing', signal: AbortSignal) => new Promise((resolve, reject) => {
    pending.push({ product, signal, finish: () => resolve(gridFixture(product).manifest), fail: () => reject(new Error('Source outage')) });
  }));
  t.mock.method(client, 'load', async () => { throw new Error('Frame unavailable'); });
  rememberLoadedFrames(t, client);
  const controller = createGridController(client, () => {}); t.after(() => controller.detach());
  const input = { enabled: true, mode: 'none' as const, altitude: 8000, time: WEATHER_NOW, online: true, visible: true };
  controller.configure(input); controller.attach(); t.mock.timers.tick(0); await flush();
  assert.equal(pending.length, 0, 'advisories alone do not discover forecasts');
  controller.configure({ ...input, mode: 'icingProbability' }); t.mock.timers.tick(0); await flush();
  assert.equal(pending[0]!.product, 'icing', 'icing never waits behind cloud discovery');
  controller.configure({ ...input, mode: 'icingSeverity', altitude: 8500 });
  assert.equal(pending[0]!.signal.aborted, false, 'fields and altitudes share their family catalog');
  controller.configure({ ...input, mode: 'cloudCover' });
  assert.equal(pending[0]!.signal.aborted, true);
  pending[0]!.finish(); await flush(); t.mock.timers.tick(0); await flush();
  assert.equal(controller.getSnapshot().products.icing.manifest, undefined, 'obsolete discoveries cannot publish');
  assert.equal(pending[1]!.product, 'clouds');
  pending[1]!.fail(); await flush();
  assert.equal(controller.getSnapshot().products.clouds.error, 'Source outage');
  controller.configure({ ...input, mode: 'icingProbability' }); t.mock.timers.tick(0); await flush();
  pending[2]!.finish(); await flush();
  assert.ok(controller.getSnapshot().products.icing.manifest, 'one family failure leaves the other usable');
  t.mock.timers.tick(299_999); await flush(); assert.equal(pending.length, 3);
  t.mock.timers.tick(1); await flush(); assert.equal(pending[3]!.product, 'icing');
  controller.configure({ ...input, visible: false });
  assert.equal(pending[3]!.signal.aborted, true);
  assert.equal(controller.getSnapshot().products.icing.loading, false);
  pending[3]!.finish(); await flush();
});

for (const restored of [false, true]) test(`a cold-server failure recovers to the complete timeline (${restored ? 'saved catalog' : 'first visit'})`, async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: WEATHER_NOW });
  const manifest = gridFixture('icing').manifest, client = new GridClient('https://app.test/');
  let checks = 0;
  t.mock.method(client, 'restore', () => ({ loading: false, ...(restored ? { manifest } : {}) }));
  t.mock.method(client, 'refresh', async () => {
    if (++checks === 1) throw new Error('Weather forecast: 503 Service Unavailable');
    return manifest;
  });
  t.mock.method(client, 'load', async (_manifest: DecodedGrid['manifest'], frame: DecodedGrid['frame']) => {
    if (checks < 2) throw new Error('Weather forecast: 503 Service Unavailable');
    return { manifest, frame, values: new Float32Array(144), byteLength: 592 };
  });
  rememberLoadedFrames(t, client);
  let prepared!: () => void;
  const complete = new Promise<void>(resolve => { prepared = resolve; });
  const controller = createGridController(client, state => {
    if (state.preparation?.ready === 3) prepared();
  }, ['icing']); t.after(() => controller.detach());
  controller.configure({ enabled: true, mode: 'icingProbability', altitude: 8000, time: WEATHER_NOW, online: true, visible: true });
  controller.attach(); t.mock.timers.tick(0); await flush();
  assert.equal(controller.getSnapshot().loading, false);
  assert.match(controller.getSnapshot().error!, /503/);
  if (!restored) assert.equal(controller.getSnapshot().preparation, undefined);
  t.mock.timers.tick(29_999); await flush(); assert.equal(checks, 1);
  t.mock.timers.tick(1); await flush();
  assert.equal(checks, 2);
  assert.equal(controller.getSnapshot().data?.frame.validTime, WEATHER_NOW);
  assert.deepEqual(gridTimes(controller.getSnapshot(), 'icingProbability', 8000),
    manifest.frames.filter(frame => frame.altitudeFtMsl === 8000).map(frame => frame.validTime));
  await complete;
  assert.deepEqual(controller.getSnapshot().preparation, { ready: 3, total: 3, failed: 0 });
  t.mock.timers.tick(299_999); await flush(); assert.equal(checks, 2);
  t.mock.timers.tick(1); await flush(); assert.equal(checks, 3);
});

test('the first positive float32 SLD value never uses the zero legend bin', () => {
  const color = gridColorizer('sldPotential');
  assert.equal(color(0, 0, 0, undefined)[3], 0);
  assert.deepEqual(color(Math.fround(.01), 0, 0, undefined), color(.1, 0, 0, undefined));
  assert.notDeepEqual(color(Math.fround(.01), 0, 0, undefined), color(.25, 0, 0, undefined));
});

test('a validated frame displays while its file save is pending without claiming offline readiness', { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: WEATHER_NOW });
  const fixture = gridFixture('clouds'), manifest = fixture.manifest, client = new GridClient('https://pending-save.test/');
  const { cache } = cacheFixture(t, 'zlayers-plugin-files-v1:weather-awc:grids');
  const original = cache.put.bind(cache);
  let release!: () => void;
  const saving = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(cache, 'put', async (...args: Parameters<typeof original>) => { await saving; return original(...args); });
  t.mock.method(client, 'restore', () => ({ loading: false, manifest }));
  t.mock.method(client, 'refresh', async () => manifest); t.mock.method(client, 'remember', () => true);
  const fetch = t.mock.method(globalThis, 'fetch', async (input: string) => {
    const frame = manifest.frames.find(frame => input.endsWith(frame.path))!;
    return new Response(bytes(fixture.files[frame.path]!));
  });
  let wake = () => {};
  const controller = createGridController(client, () => wake(), ['clouds']); t.after(() => { release(); controller.detach(); });
  const until = (condition: () => boolean) => new Promise<void>(resolve => { wake = () => { if (condition()) resolve(); }; wake(); });
  const visible = until(() => !!controller.getSnapshot().data);
  controller.configure({ enabled: true, mode: 'cloudCover', altitude: 8000, time: WEATHER_NOW, online: true, visible: true });
  controller.attach(); await visible;
  const shown = controller.getSnapshot().data!;
  assert.equal(shown.frame.validTime, WEATHER_NOW); assert.equal(client.saved(shown), false);
  assert.equal(controller.getSnapshot().preparation?.ready, 0);
  assert.equal(controller.getSnapshot().preparation?.limited, undefined);
  assert.equal(fetch.mock.callCount(), 1, 'save retains the decode admission until cleanup');
  const complete = until(() => controller.getSnapshot().preparation?.ready === 3); release(); await complete;
  assert.equal(controller.getSnapshot().data, shown); assert.equal(client.saved(shown), true);
});

test('denied saves keep nearby decoded frames usable without claiming the whole horizon was saved', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: WEATHER_NOW });
  const manifest = gridFixture('clouds').manifest, client = new GridClient('https://app.test/');
  t.mock.method(client, 'restore', () => ({ loading: false, manifest }));
  const calls: number[] = [];
  t.mock.method(client, 'load', async (_manifest: typeof manifest, frame: typeof manifest.frames[number]) => {
    calls.push(frame.validTime); return { manifest, frame, values: new Float32Array(240), byteLength: 976 };
  });
  rememberLoadedFrames(t, client); t.mock.method(client, 'saved', () => false);
  const controller = createGridController(client, () => {}); t.after(() => controller.detach());
  controller.configure({ enabled: true, mode: 'cloudCover', altitude: 8000, time: WEATHER_NOW, online: true, visible: true });
  controller.attach(); await flush(); await flush();
  assert.equal(controller.getSnapshot().data?.frame.validTime, WEATHER_NOW);
  assert.deepEqual(controller.getSnapshot().preparation, { ready: 0, total: 3, failed: 0, limited: true });
  assert.ok(!calls.includes(WEATHER_NOW + 10800000), 'distant work must not be converted just to be discarded');
});

test('retry saves unsaved decoded frames without replacing the display, then resumes the horizon for offline reopening', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: WEATHER_NOW });
  const fixture = gridFixture('clouds'), manifest = fixture.manifest, client = new GridClient('https://app.test/');
  const { cache } = cacheFixture(t, 'zlayers-plugin-files-v1:weather-awc:grids');
  const put = cache.put.bind(cache);
  let denied = true;
  t.mock.method(cache, 'put', async (...args: Parameters<typeof put>) => {
    if (denied) throw new DOMException('Full', 'QuotaExceededError');
    return put(...args);
  });
  t.mock.method(client, 'restore', () => ({ loading: false, manifest }));
  t.mock.method(client, 'refresh', async () => manifest);
  t.mock.method(client, 'remember', () => true);
  const fetch = t.mock.method(globalThis, 'fetch', async (input: string) => {
    const frame = manifest.frames.find(frame => input.endsWith(frame.path))!;
    return new Response(bytes(fixture.files[frame.path]!));
  });
  let changed = () => {};
  const controller = createGridController(client, () => changed(), ['clouds']); t.after(() => controller.detach());
  const until = (condition: () => boolean) => new Promise<void>(resolve => {
    changed = () => { if (condition()) resolve(); }; changed();
  });
  const limited = until(() => !!controller.getSnapshot().preparation?.limited && controller.getSnapshot().nearby?.length === 2);
  controller.configure({ enabled: true, mode: 'cloudCover', altitude: 8000, time: WEATHER_NOW, online: true, visible: true });
  controller.attach(); await limited;
  const displayed = controller.getSnapshot().data!;
  assert.equal(client.saved(displayed), false);
  assert.deepEqual(controller.getSnapshot().preparation, { ready: 0, total: 3, failed: 0, limited: true });
  const complete = until(() => controller.getSnapshot().preparation?.ready === 3);
  denied = false; controller.retry(); await complete;
  assert.equal(controller.getSnapshot().data, displayed, 'saving does not clear or replace the displayed data');
  assert.equal(client.saved(displayed), true);
  assert.deepEqual(controller.getSnapshot().preparation, { ready: 3, total: 3, failed: 0 });
  const requests = fetch.mock.callCount(), reopened = new GridClient(client.baseUrl);
  for (const frame of manifest.frames.filter(frame => frame.validTime >= WEATHER_NOW)) {
    assert.equal((await reopened.load(manifest, frame, signal(), false)).frame, frame);
  }
  assert.equal(fetch.mock.callCount(), requests, 'every prepared frame is reusable without a network');
});

for (const product of ['clouds', 'winds'] as const) test(`${product} metadata save failures preserve live frames and recover on retry`, async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: WEATHER_NOW });
  const manifest = gridFixture(product).manifest, client = new GridClient('https://app.test/');
  const values = new Map<string, string>(), calls: number[] = [];
  let denied = true;
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (denied) throw new DOMException('Full', 'QuotaExceededError');
      values.set(key, value);
    },
  } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); });
  t.mock.method(client, 'refresh', async () => manifest);
  t.mock.method(client, 'load', async (_manifest: typeof manifest, frame: typeof manifest.frames[number]) => {
    calls.push(frame.validTime); return { manifest, frame, values: new Float32Array(240), byteLength: 976 };
  });
  rememberLoadedFrames(t, client, false);
  const controller = createGridController(client, () => {}, [product]); t.after(() => controller.detach());
  controller.configure({ enabled: true, mode: product === 'clouds' ? 'cloudCover' : 'temperature',
    altitude: product === 'clouds' ? 8000 : 5000, time: WEATHER_NOW, online: true, visible: true });
  controller.attach(); t.mock.timers.tick(0); await flush(); await flush();
  assert.equal(controller.getSnapshot().data?.frame.validTime, WEATHER_NOW, 'live data stays usable');
  assert.match(controller.getSnapshot().products[product].storageError!, /could not be saved for reopening offline/);
  assert.equal(client.restore(product).manifest, undefined, 'frame receipts alone cannot restore a catalog');
  if (product === 'clouds') assert.deepEqual(controller.getSnapshot().preparation,
    { ready: 0, total: 3, failed: 0, limited: true });
  assert.deepEqual(calls, [WEATHER_NOW, WEATHER_NOW + 3600000], 'only the selected neighborhood loads without metadata persistence');
  denied = false;
  controller.retry(); await flush(); await flush();
  assert.equal(controller.getSnapshot().products[product].storageError, undefined);
  assert.deepEqual(client.restore(product).manifest, manifest, 'retry saves the restart pointer without a network refresh');
  assert.equal(calls.filter(time => time === WEATHER_NOW).length, 1, 'retry retains the selected decoded frame');
  if (product === 'clouds') {
    assert.deepEqual(controller.getSnapshot().preparation, { ready: 3, total: 3, failed: 0 });
    assert.ok(calls.includes(WEATHER_NOW + 10800000), 'saving metadata resumes the remaining horizon');
  }
});

test('the actual grid client reuses warmed bundles and releases them when its neighborhood is cleared', async t => {
  const fixture = gridFixture('clouds'), client = new GridClient('https://app.test/');
  const frames = fixture.manifest.frames.slice(0, 2);
  const fetch = t.mock.method(globalThis, 'fetch', async (input: string) => {
    const frame = frames.find(frame => input.endsWith(frame.path))!;
    return new Response(bytes(fixture.files[frame.path]!));
  });
  client.neighborhood('clouds', fixture.manifest, frames);
  const first = await client.load(fixture.manifest, frames[0]!, signal(), true);
  await client.prepare(fixture.manifest, frames[1]!, signal(), true);
  const next = client.peek(fixture.manifest, frames[1]!)!;
  assert.ok(next);
  assert.equal(await client.load(fixture.manifest, frames[1]!, signal(), false), next);
  assert.equal(await client.load(fixture.manifest, frames[0]!, signal(), false), first);
  assert.equal(fetch.mock.callCount(), 2);
  client.neighborhood('clouds');
  assert.equal(client.peek(fixture.manifest, frames[0]!), undefined);
  assert.equal(client.peek(fixture.manifest, frames[1]!), undefined);
});

test('display eligibility keeps the applicable hourly frame across advisory ticks but rejects other times and expired horizons', () => {
  const manifest = gridFixture('clouds').manifest;
  const data = { manifest, frame: manifest.frames[1]!, values: new Float32Array(), byteLength: 0 };
  assert.equal(gridMatchesTime(data, WEATHER_NOW), true);
  assert.equal(gridMatchesTime(data, WEATHER_NOW + 20 * 60000), true);
  assert.equal(gridMatchesTime(data, WEATHER_NOW - 1), false);
  assert.equal(gridMatchesTime(data, WEATHER_NOW + 3600000), false);
  const last = { ...data, frame: manifest.frames.at(-1)! };
  assert.equal(gridMatchesTime(last, last.frame.validTime), true);
  assert.equal(gridMatchesTime(last, last.frame.validTime + 1), false);
});
