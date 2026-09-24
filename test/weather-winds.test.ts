import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { GRID_BELOW_GROUND, GRID_MISSING, GRID_OUTSIDE, isAwcGridManifest } from '@zlayer/contracts';
import { decodeGrib } from '../src/layers/weather-awc/grids/grib';
import { convertValue, rotateWinds } from '../src/layers/weather-awc/grids/conversion';
import { OUTPUT_GRID } from '../src/layers/weather-awc/grids/native-source';
import { barbGeometry, windSample, windSymbols, type WindView } from '../src/layers/weather-awc/grids/wind';
import { pressureAltitude, windFrames, windLevelLabel, windPressure, restoredWindAltitude } from '../src/layers/weather-awc/grids/wind-levels';
import { WindInterpolation } from '../src/layers/weather-awc/grids/wind-interpolation';
import { gridKey, gridMatchesTime, type DecodedGrid } from '../src/layers/weather-awc/grids/format';
import { gridFixture } from './fixtures/awc-grids';
import { WEATHER_NOW } from './fixtures/awc-advisories';
import { mountWindMap } from '../src/layers/weather-awc/grids/wind-map';
import { weatherAwcPreferences } from '../src/layers/weather-awc/preferences';
import type { WeatherController } from '../src/layers/weather-awc/controller';
import type { Map as MapLibreMap } from 'maplibre-gl';
import reference from './fixtures/awc-grib/wind-reference.json';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
test('live HRRR pressure fields agree with every GDAL sample; vectors rotate at their native cell', () => {
  const fields = reference.fields.map(item => {
    const raw = Uint8Array.from(readFileSync(new URL(`./fixtures/awc-grib/${item.name}`, import.meta.url)));
    assert.equal(hash(raw), item.sourceSha256);
    const data = decodeGrib(raw.buffer, item.identity);
    assert.equal(hash(new Uint8Array(data.values.buffer)), item.decodedSha256);
    assert.throws(() => decodeGrib(raw.buffer, { ...item.identity, pressureHpa: 700 }), /pressure/);
    return data;
  });
  const indices = Int32Array.from(reference.samples.map(s => s.cell));
  const east = Float32Array.from(indices, at => convertValue('windEast', fields[2]!.values[at]!));
  const north = Float32Array.from(indices, at => convertValue('windNorth', fields[3]!.values[at]!));
  rotateWinds(fields[2]!.grid, indices, east, north);
  for (const [i, sample] of reference.samples.entries()) {
    assert.ok(Math.abs(east[i]! - sample.east) < .01, `east at ${sample.longitude}`);
    assert.ok(Math.abs(north[i]! - sample.north) < .01, `north at ${sample.longitude}`);
    assert.equal(convertValue('temperature', fields[1]!.values[sample.cell]!), sample.temperature);
  }
  const earth = Float32Array.of(20, GRID_MISSING), northerly = Float32Array.of(-10, 5);
  rotateWinds({ ...fields[2]!.grid, gridRelative: false }, indices.subarray(0, 2), earth, northerly);
  assert.deepEqual([...earth], [20, GRID_MISSING]); assert.deepEqual([...northerly], [-10, GRID_MISSING]);
});

test('wind direction is FROM true north; calm and 5/10/50 kt barbs preserve conventional meanings', () => {
  assert.equal(windSample(0, -20)?.direction, 0);
  assert.equal(windSample(-20, 0)?.direction, 90);
  assert.equal(windSample(0, 20)?.direction, 180);
  assert.equal(windSample(20, 0)?.direction, 270);
  assert.equal(windSample(2.49, 0)?.barb, 0); assert.equal(windSample(2.5, 0)?.barb, 5);
  assert.equal(windSample(GRID_BELOW_GROUND, 0), undefined);
  assert.equal(barbGeometry(0).calm, true);
  assert.equal(barbGeometry(25).lines.length, 4); // shaft, two full, one half
  assert.equal(barbGeometry(50).flags.length, 1);
  assert.equal(barbGeometry(150).flags.length, 3);
  for (const speed of [5, 45, 95, 200, 550]) {
    const shape = barbGeometry(speed);
    assert.ok([...shape.lines, ...shape.flags].flat().every(n => n >= 0 && n < 64));
  }
});

test('wind metadata distinguishes pressure altitude from MSL and rejects mismatched vertical coordinates', () => {
  const manifest = gridFixture('winds').manifest;
  assert.equal(isAwcGridManifest(manifest), true);
  assert.equal(isAwcGridManifest({ ...manifest, frames: manifest.frames.map(f => ({ ...f, altitudeFtMsl: 5000 })) }), false);
  assert.equal(isAwcGridManifest({ ...manifest, frames: manifest.frames.map(f => ({ ...f, pressureHpa: 85000 })) }), false);
  assert.equal(pressureAltitude(850), 4800); assert.equal(pressureAltitude(500), 18300);
  assert.ok(pressureAltitude(100) > 53000 && pressureAltitude(100) < 53200);
});

test('MSL winds use local heights, interpolate vectors across north and expand only missing brackets', () => {
  const output = new Float32Array(12), interpolation = new WindInterpolation(5000, output);
  const bands = (...values: number[][]) => Float32Array.from(values.flat());
  assert.deepEqual(interpolation.add(900, bands([4000, 3000, 6000], [10, 10, 40], [-10, -20, 0], [10, 20, 40])), { below: true, above: true });
  assert.deepEqual(interpolation.add(850, bands([6000, 7000, 8000], [-10, 30, 60], [-10, 20, 0], [0, 0, 60])), { below: true, above: false });
  assert.equal(output[0], 5000); assert.equal(output[1], 5000); assert.equal(output[2], GRID_MISSING);
  assert.equal(windSample(output[3]!, output[6]!)?.direction, 0, 'opposing east/west components retain a northerly wind');
  assert.equal(windSample(output[3]!, output[6]!)?.speed, 10);
  assert.equal(windSample(output[4]!, output[7]!)?.speed, 20);
  assert.equal(output[9], 5); assert.equal(output[10], 10);
  assert.deepEqual(interpolation.add(925, bands([2000, 1000, 4000], [5, 5, 20], [0, 0, 0], [5, 5, 20])), { below: false, above: false });
  assert.deepEqual([...output.slice(0, 3)], [5000, 5000, 5000]);
  assert.equal(output[5], 30); assert.equal(output[11], 30);
  assert.throws(() => interpolation.add(900, new Float32Array(12)), /expand the bracket/);
});

test('wind interpolation preserves missing fields, terrain masks, coverage and exact levels without extrapolation', () => {
  const output = new Float32Array(20), terrain = Float32Array.of(0, 1600, 0, NaN, 0);
  const interpolation = new WindInterpolation(5000, output, terrain);
  interpolation.add(900, Float32Array.from([
    4000, 4000, GRID_MISSING, GRID_OUTSIDE, 6000,
    GRID_MISSING, 10, 10, GRID_OUTSIDE, 10,
    10, 10, 10, GRID_OUTSIDE, 10,
    10, 10, 10, GRID_OUTSIDE, 10,
  ]));
  interpolation.add(850, Float32Array.from([
    6000, 6000, 6000, GRID_OUTSIDE, 7000,
    20, 20, 20, GRID_OUTSIDE, 20,
    20, 20, 20, GRID_OUTSIDE, 20,
    0, 0, 0, GRID_OUTSIDE, 0,
  ]));
  assert.equal(output[5], GRID_MISSING); assert.equal(output[15], 5, 'a missing wind component does not invent or erase temperature');
  for (const band of [0, 1, 2, 3]) {
    assert.equal(output[band * 5 + 1], GRID_BELOW_GROUND);
    assert.equal(output[band * 5 + 2], GRID_MISSING);
    assert.equal(output[band * 5 + 3], GRID_OUTSIDE);
    assert.equal(output[band * 5 + 4], GRID_MISSING);
  }
  const exact = new WindInterpolation(5000, new Float32Array(4));
  assert.deepEqual(exact.add(850, Float32Array.of(5000, 20, 10, 5)), { below: false, above: false });
  exact.add(825, new Float32Array(4).fill(GRID_MISSING));
  exact.add(800, new Float32Array(4).fill(GRID_OUTSIDE));
  assert.deepEqual([...exact.values], [5000, 20, 10, 5]);
});

test('an exact MSL sample discovered in either search direction survives a missing neighboring height', () => {
  for (const [seedHeight, pressure, neighborHeight] of [[6000, 875, 4000], [4000, 825, 6000]] as const) {
    const interpolation = new WindInterpolation(5000, new Float32Array(8));
    // The second cell drives expansion. The first cell has no seed height but
    // supplies an exact sample on the next level, so it needs no interpolation.
    assert.deepEqual(interpolation.add(850, Float32Array.of(GRID_MISSING, seedHeight, GRID_MISSING, 10, GRID_MISSING, 20, GRID_MISSING, 10)),
      { below: seedHeight > 5000, above: seedHeight < 5000 });
    assert.deepEqual(interpolation.add(pressure, Float32Array.of(5000, neighborHeight, 20, 30, 10, 40, 5, 0)), { below: false, above: false });
    assert.deepEqual([...interpolation.values], [5000, 5000, 20, 20, 10, 30, 5, 5]);
  }
});

test('standard-pressure conversion covers both atmospheric layers and all selectable flight levels', () => {
  // Independent standard-atmosphere tabulations (hPa); allow their printed precision.
  for (const [metres, hpa] of [[0, 1013.25], [5000, 540.199], [11000, 226.3206], [15000, 120.4457]] as const) {
    assert.ok(Math.abs(windPressure(metres / .3048) - hpa) < .01);
  }
  for (let altitude = 18000; altitude <= 53000; altitude += 1000) {
    const pressure = windPressure(altitude);
    assert.ok(pressure >= 100 && pressure <= 1000);
    assert.equal(pressureAltitude(pressure), altitude);
    assert.ok(pressure > windPressure(altitude + 1));
  }
});

test('FL180 uses standard pressure and log-pressure interpolation, keeping forecast MSL height separate', () => {
  const pressure = windPressure(18000);
  assert.ok(Math.abs(pressure - 506) < 0.05);
  const output = new Float32Array(4), interpolation = new WindInterpolation(18000, output);
  interpolation.add(pressure * Math.exp(.1), Float32Array.of(12000, 10, -10, 10));
  interpolation.add(pressure / Math.exp(.1), Float32Array.of(14000, 30, -30, -10));
  for (const [i, expected] of [13000, 20, -20, 0].entries()) assert.ok(Math.abs(output[i]! - expected) < 1e-5);
  const inverted = new WindInterpolation(18000, new Float32Array(4));
  inverted.add(525, Float32Array.of(14000, 10, -10, 10));
  inverted.add(500, Float32Array.of(12000, 30, -30, -10));
  assert.ok(inverted.values.every(value => value === GRID_MISSING), 'inverted forecast heights cannot supply a flight-level sample');
  assert.equal(windLevelLabel(17500), '17,500 ft MSL'); assert.equal(windLevelLabel(18000), 'FL180');
  assert.equal(restoredWindAltitude({ awcWindPressure: 850 }), 5000);
  assert.equal(restoredWindAltitude({ awcWindPressure: 500 }), 18000);
  assert.equal(restoredWindAltitude({ awcWindAltitude: 17500, awcWindPressure: 850 }), 17500);
  assert.equal(restoredWindAltitude({ awcWindAltitude: NaN, awcWindPressure: 85000 }), 5000);
});

test('derived wind identity covers every source bracket, height, time and run without changing the source catalog', () => {
  const manifest = gridFixture('winds').manifest;
  const msl = windFrames(manifest, 5000)[1]!, higher = windFrames(manifest, 5500)[1]!;
  assert.equal(msl.altitudeFtMsl, 5000); assert.equal(msl.pressureHpa, undefined);
  assert.ok(manifest.frames.every(f => f.altitudeFtMsl === null && f.pressureHpa !== undefined));
  assert.notEqual(gridKey(manifest, msl), gridKey(manifest, higher));
  assert.notEqual(gridKey(manifest, msl), gridKey(manifest, { ...msl, validTime: msl.validTime + 3600000 }));
  assert.notEqual(gridKey(manifest, msl), gridKey({ ...manifest, grid: { ...manifest.grid, bounds: [-125, 22, -65, 51] } }, msl));
  const replacement = gridFixture('winds', 2).manifest;
  assert.notEqual(gridKey(manifest, msl), gridKey(replacement, windFrames(replacement, 5000)[1]!));
  const changed = { ...msl, levels: msl.levels.map(f => 'sha256' in f ? { ...f, sha256: 'a'.repeat(64) } : f) };
  assert.notEqual(gridKey(manifest, msl), gridKey(manifest, changed));
  const data = { manifest, frame: msl, values: new Float32Array(192), byteLength: 784 };
  assert.equal(gridMatchesTime(data, msl.validTime + 60_000), true);
  assert.equal(gridMatchesTime(data, msl.validTime + 3600000), false);
  assert.deepEqual(windFrames(manifest, 18000), [], 'no flight-level frames outside the source pressure range');
  const high = { ...manifest, frames: [525, 500].map(pressureHpa => ({ ...manifest.frames[0]!, pressureHpa })) };
  const flightLevel = windFrames(high, 18000)[0]!;
  assert.equal(flightLevel.altitudeFtMsl, null); assert.ok(Math.abs(flightLevel.pressureHpa! - 506) < .05);
  assert.equal(flightLevel.levels.length, 2);
});

const mercatorY = (lat: number) => (1 - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / Math.PI) / 2;
const latAt = (y: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI;
function view(zoom: number, width = 1024, height = 768): WindView {
  const world = 512 * 2 ** zoom, x = 80 / 360, y = mercatorY(38);
  return { zoom, width, height, bounds: [(x - width / 2 / world) * 360 - 180, latAt(y + height / 2 / world),
    (x + width / 2 / world) * 360 - 180, latAt(y - height / 2 / world)],
    project: (lng, lat) => ({ x: ((lng + 180) / 360 - x) * world + width / 2, y: (mercatorY(lat) - y) * world + height / 2 }) };
}
test('barb density follows screen area and zoom with nested anchors and no duplicate model samples', () => {
  const fixture = gridFixture('winds'), manifest = { ...fixture.manifest, grid: OUTPUT_GRID };
  const count = OUTPUT_GRID.width * OUTPUT_GRID.height, values = new Float32Array(count * 4);
  values.fill(5000, 0, count); values.fill(20, count, count * 2); values.fill(-10, count * 2, count * 3); values.fill(5, count * 3);
  const data: DecodedGrid = { manifest, frame: manifest.frames[0]!, values, byteLength: values.byteLength + 16 };
  for (const zoom of [4, 6, 7, 8, 10, 15, 19]) {
    const camera = view(zoom), symbols = windSymbols(data, camera);
    assert.ok(symbols.length <= 240, `bounded symbols at zoom ${zoom}`);
    assert.equal(new Set(symbols.map(s => s.cell)).size, symbols.length);
    const points = symbols.map(s => camera.project(s.longitude, s.latitude));
    for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++)
      assert.ok(Math.hypot(points[i]!.x - points[j]!.x, points[i]!.y - points[j]!.y) >= 64 - 1e-6);
  }
  const coarse = windSymbols(data, view(7)), fine = windSymbols(data, view(8));
  assert.ok(coarse.length > 30 && fine.length > 30);
  assert.ok(fine.some(a => coarse.some(b => a.longitude === b.longitude && a.latitude === b.latitude)), 'world anchors survive subdivision');
  // All missing/below-ground data produces no weather symbols.
  values.fill(GRID_BELOW_GROUND, count, count * 3);
  assert.deepEqual(windSymbols(data, view(7)), []);
});

test('wind steps clear old symbols and inspection until the matching source finishes, including canceled replies', async t => {
  const manifest = gridFixture('winds').manifest;
  const bundle = (time: number): DecodedGrid => ({ manifest,
    frame: windFrames(manifest, 5000).find(frame => frame.validTime === time)!,
    values: new Float32Array(192).fill(GRID_MISSING), byteLength: 784,
  });
  const first = bundle(WEATHER_NOW), next = bundle(WEATHER_NOW + 3600000);
  const state: Pick<ReturnType<WeatherController['getSnapshot']>, 'preferences' | 'selectedTime' | 'now' | 'wind' | 'windDisplay' | 'windRenderError' | 'forecastRetry'> = {
    preferences: weatherAwcPreferences.select({ awcEnabled: true, awcWindBarbs: true, awcWindAltitude: 5000 }),
    now: WEATHER_NOW, selectedTime: null, forecastRetry: 0,
    wind: { data: first, loading: false, products: { clouds: { loading: false }, icing: { loading: false }, winds: { loading: false } } },
  };
  const displayedTime = () => state.windDisplay?.frame.validTime;
  const controller = { getSnapshot: () => state,
    setWindDisplay(data: DecodedGrid | undefined) { state.windDisplay = data; },
    setWindRenderError(error: string | undefined) { state.windRenderError = error; },
  } as unknown as WeatherController;
  const pending: { resolve: () => void; reject: (error: Error) => void }[] = [];
  let layer: { visibility: string } | undefined, source: object | undefined;
  let denyLayer = true;
  const visibility = () => layer?.visibility;
  const map = {
    getLayer: () => layer, getSource: () => source,
    addLayer() { if (denyLayer) throw new Error('Map layer failed'); layer = { visibility: 'none' }; },
    addSource() { source = { setData: () => new Promise<void>((resolve, reject) => pending.push({ resolve, reject })) }; },
    removeLayer() { layer = undefined; }, removeSource() { source = undefined; },
    setLayoutProperty(_id: string, _key: string, value: string) { layer!.visibility = value; },
    getCanvas: () => ({ clientWidth: 800, clientHeight: 600 }), getZoom: () => 7,
    getCenter: () => ({ lng: -100, lat: 38 }),
    unproject: ([x, y]: number[]) => ({ lng: -105 + x! / 80, lat: 42 - y! / 80 }),
    project: ([lng, lat]: number[]) => ({ x: (lng! + 105) * 80, y: (42 - lat!) * 80 }),
    on() {}, off() {},
  } as unknown as MapLibreMap;
  const renderer = mountWindMap(map, controller, 'weather'); t.after(() => renderer.destroy());
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  const finish = async (index: number) => { pending[index]!.resolve(); await flush(); };
  renderer.update(); await flush();
  assert.equal(state.windRenderError, 'Map layer failed');
  assert.ok(source); assert.equal(layer, undefined);
  renderer.update(); await flush(); assert.equal(pending.length, 0);
  denyLayer = false; state.forecastRetry++;
  renderer.update(); assert.equal(visibility(), 'none'); await finish(0);
  assert.equal(state.windRenderError, undefined);
  assert.equal(displayedTime(), WEATHER_NOW);
  state.selectedTime = WEATHER_NOW + 60000; renderer.update();
  assert.equal(visibility(), 'visible', 'an advisory tick still uses the same hourly forecast');
  assert.equal(pending.length, 1);
  state.selectedTime = next.frame.validTime; renderer.update();
  assert.equal(layer, undefined, 'old data clears before acquisition updates its loading state');
  assert.equal(displayedTime(), undefined);
  state.wind.data = next; renderer.update();
  assert.equal(visibility(), 'none');
  state.selectedTime = WEATHER_NOW; state.wind.data = first; renderer.update();
  await finish(1);
  assert.equal(displayedTime(), undefined, 'an obsolete source completion cannot commit');
  assert.equal(visibility(), 'none');
  await finish(2);
  assert.equal(displayedTime(), WEATHER_NOW);
  assert.equal(visibility(), 'visible');
  state.selectedTime = next.frame.validTime; state.wind.data = next; renderer.update();
  pending[3]!.reject(new Error('Wind source failed')); await flush();
  assert.equal(state.windRenderError, 'Wind source failed');
  assert.equal(displayedTime(), undefined); assert.equal(visibility(), 'none');
  renderer.update(); await flush(); assert.equal(pending.length, 4, 'status updates do not loop on a failed source');
  state.forecastRetry++; renderer.update(); await finish(4);
  assert.equal(state.windRenderError, undefined); assert.equal(displayedTime(), next.frame.validTime);
  state.forecastRetry++; renderer.update(); assert.equal(pending.length, 5, 'healthy symbols are not rebuilt by retry');
  state.selectedTime = next.frame.validTime; state.wind.data = undefined; state.wind.error = 'Offline frame unavailable'; renderer.update();
  assert.equal(layer, undefined); assert.equal(displayedTime(), undefined);
});
