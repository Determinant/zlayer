import assert from 'node:assert/strict';
import test from 'node:test';
import type { GeoPointFeature } from '@zlayer/contracts';
import { glideAirport, visibleGlideAirports, FEET_PER_NM } from '../src/layers/glide/airports';
import { mergeFootprints, ownshipOutline } from '../src/layers/glide/geometry';
import { glidePreferences } from '../src/layers/glide/preferences';
import { readElevationGrid, elevationGridLayout, type ElevationGrid } from '../src/core/terrain/elevation';
import { nmPerWorldUnit, project, type Point, type Segment } from '../src/core/geo/route-corridor';
import { boundsViewport, localRouteSegments, insideViewport, routeMask, viewportBounds, inRouteCorridor } from '../src/layers/glide/coverage';
import { prepareGlideProfile, profileFootprint, GLIDE_SECTORS } from '../src/layers/glide/profile';
import { GlideCalculator } from '../src/layers/glide/calculator';
import { GlidePlanner } from '../src/layers/glide/planner';
import { airportFootprint } from './helpers/glide';
import { GLIDE_INSET_NM } from '../src/layers/glide/outline';
import type { GlideRequest } from '../src/layers/glide/types';
const feature = (properties: Partial<GeoPointFeature['properties']> = {}, coordinate: [number, number] = [0, 0]): GeoPointFeature => ({
  type: 'Feature', id: 'airport:test', geometry: { type: 'Point', coordinates: coordinate },
  properties: { kind: 'landing-facility', faaId: 'TEST', facilityType: 'AIRPORT', status: 'O', elevationFt: 0,
    runways: [{ id: '09/27', lengthFt: 1800, widthFt: 40, surface: 'TURF' }], ...properties },
});
const airport = glideAirport(feature())!;
function grid(sample: (x: number, y: number) => number = () => 0): ElevationGrid {
  const size = 2 ** 11 * 256, width = 600, height = 600, x = size / 2 - 300, y = size / 2 - 300;
  return { size, width, height, x, y, values: Float32Array.from({ length: width * height }, (_, i) => sample(i % width - 300, Math.floor(i / width) - 300)) };
}
const radiusFeet = (ring: number[][], index = 0) => Math.hypot(ring[index]![0]! - 0.5, ring[index]![1]! - 0.5) * nmPerWorldUnit(0.5) * FEET_PER_NM;

test('glide includes private/unpaved runways and rejects closed/water/heliport or unknown runway and elevation data', () => {
  assert.ok(glideAirport(feature({ use: 'PR' })));
  assert.ok(glideAirport(feature({ facilityType: 'GLIDERPORT', elevationFt: -150 })));
  for (const patch of [{ status: 'C' }, { facilityType: 'HELIPORT' }, { facilityType: 'SEAPLANE BASE' },
    { elevationFt: NaN }, { runways: [] }, { runways: [{ id: '09/27', lengthFt: 0 }] },
    { runways: [{ id: '09W/27W', lengthFt: 2000, surface: 'WATER' }] },
    { runways: [{ id: '09/27', lengthFt: 2000, condition: 'CLOSED' }] }]) assert.equal(glideAirport(feature(patch)), undefined);
});

test('airport selection requires a route, a visible origin and the 20 NM corridor, with date-line wrapping', () => {
  const view = boundsViewport([-1, -1, 1, 1]);
  const legs: Segment[] = [[project([-1, 0]), project([1, 0])]];
  const select = (coordinate: Point) => visibleGlideAirports([feature({}, coordinate)], view, legs, 6500, 8).length;
  assert.equal(select([0, .32]), 1); assert.equal(select([0, .34]), 0);
  assert.equal(select([1.01, 0]), 0, 'even overlapping offscreen airport footprints are excluded');
  assert.equal(visibleGlideAirports([feature()], view, [], 6500, 8).length, 0);
  assert.equal(visibleGlideAirports([feature({ elevationFt: 6400 })], view, legs, 6500, 8).length, 0);
  const wrapped = boundsViewport([179.9, -.1, 180.1, .1]);
  const crossing = localRouteSegments([[project([179.8, 0]), project([180.2, 0])]], wrapped);
  assert.equal(visibleGlideAirports([feature({}, [-179.95, 0])], wrapped, crossing, 6500, 8).length, 1);
});

test('flat-ground reverse coverage uses altitude above each airport, reserve, and glide ratio', () => {
  for (const [altitude, ratio, elevation] of [[6500, 8, 0], [6500, 8, 2000], [3500, 12, 0]]) {
    const { polygon, incomplete } = airportFootprint({ ...airport, elevationFt: elevation! }, altitude!, ratio!, grid());
    assert.equal(incomplete, false);
    const actual = radiusFeet(polygon[0]!), expected = (altitude! - elevation! - 500) * ratio! - GLIDE_INSET_NM * FEET_PER_NM;
    assert.ok(actual <= expected + 0.01 && actual > expected - 400, `${actual} vs ${expected}`);
  }
});

test('a ridge shortens the footprint behind it; higher start altitudes can clear it', () => {
  const terrain = grid((x) => x >= 35 && x <= 40 ? 2800 : 0);
  const lowResult = airportFootprint(airport, 3500, 8, terrain);
  const low = lowResult.polygon[0]!;
  const high = airportFootprint(airport, 6500, 8, terrain).polygon[0]!;
  const lowFlat = airportFootprint(airport, 3500, 8, grid()).polygon[0]!;
  assert.ok(radiusFeet(low) < radiusFeet(lowFlat) * 0.7);
  assert.ok(radiusFeet(high) > radiusFeet(low) * 2);
  assert.ok(lowResult.radii[GLIDE_SECTORS / 2]! > lowResult.radii[0]! * 1.5, 'opposite side remains reachable');
});

test('unknown DEM cells cut back coverage and a narrow peak between radial bearings is retained', () => {
  const missing = airportFootprint(airport, 6500, 8, grid(x => x > 50 ? NaN : 0));
  assert.equal(missing.incomplete, true);
  assert.ok(radiusFeet(missing.polygon[0]!) < 14000);
  const peak = airportFootprint(airport, 3500, 8, grid((x, y) => x === 35 && y === 1 ? 10000 : 0));
  const peakSector = Math.floor(Math.atan2(1.5, 35.5) / (2 * Math.PI) * GLIDE_SECTORS);
  assert.ok(peak.radii[peakSector]! * nmPerWorldUnit(.5) * FEET_PER_NM < 10000, 'the bearing through the full peak cell is blocked');
  assert.ok(peak.radii[0]! > peak.radii[peakSector]! * 2, 'a ray that misses the peak must remain clear');
  const empty = airportFootprint(airport, 6500, 8, grid(() => NaN));
  assert.equal(mergeFootprints([empty.polygon]).features.length, 0);
});

test('footprint union fuses overlap/touching, preserves disjoint regions and holes, and wraps safely', () => {
  const rect = (x: number, y: number, w: number, h: number): [number, number][][] => [[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]];
  assert.equal(mergeFootprints([rect(.4, .4, .02, .02), rect(.42, .4, .02, .02)]).features[0]!.geometry.coordinates.length, 1);
  assert.equal(mergeFootprints([rect(.4, .4, .02, .02), rect(.41, .4, .02, .02)]).features[0]!.geometry.coordinates[0]!.length, 1);
  assert.equal(mergeFootprints([rect(.4, .4, .02, .02), rect(.5, .4, .02, .02)]).features[0]!.geometry.coordinates.length, 2);
  const donut = [rect(.4, .4, .1, .01), rect(.4, .49, .1, .01), rect(.4, .4, .01, .1), rect(.49, .4, .01, .1)];
  assert.equal(mergeFootprints(donut).features[0]!.geometry.coordinates[0]!.length, 2);
  const wrapped = mergeFootprints([rect(.999, .5, .002, .001)]).features[0]!.geometry.coordinates;
  assert.equal(wrapped.length, 2);
  for (const polygon of wrapped) for (const ring of polygon) for (let i = 1; i < ring.length; i++) assert.ok(Math.abs(ring[i]![0]! - ring[i - 1]![0]!) < 1);
});

test('core DEM mosaic preserves failures as unknown, wraps tiles, and responds to cancellation', async () => {
  const calls: number[] = [];
  const result = await readElevationGrid(async tile => { calls.push(tile.x); return new Float32Array(65536).fill(123); },
    [179.9, -0.1, 180.1, 0.1], 8, new AbortController().signal);
  assert.ok(calls.includes(0) && calls.includes(255));
  assert.ok(result.values.every(v => v === 123));
  const missing = await readElevationGrid(async () => { throw new Error('missing'); }, [-.1, -.1, .1, .1], 8, new AbortController().signal);
  assert.ok(missing.values.every(Number.isNaN));
  const controller = new AbortController();
  await assert.rejects(readElevationGrid(async () => { controller.abort(); return new Float32Array(65536); }, [-.1, -.1, .1, .1], 8, controller.signal), { name: 'AbortError' });
});

test('invalid saved planning values recover to bounded defaults', () => {
  assert.deepEqual(glidePreferences.select({ glideRatio: NaN, glideAltitude: Infinity, glideEnabled: 'true' }),
    { glideEnabled: false, glideAirportsEnabled: false, glideLandingsEnabled: false, glideRatio: 8, glideAltitude: 6500 });
  assert.deepEqual(glidePreferences.select({ glideRatio: 9.25, glideAltitude: 8750, glideEnabled: true }),
    { glideEnabled: true, glideAirportsEnabled: false, glideLandingsEnabled: false, glideRatio: 9.3, glideAltitude: 8800 });
  assert.equal(glidePreferences.select({ glideEnabled: true, glideAirportsEnabled: 'true' }).glideAirportsEnabled, false);
  assert.equal(glidePreferences.select({ glideEnabled: false, glideAirportsEnabled: true }).glideAirportsEnabled, true,
    'the airport preference survives switching the planner off');
});

test('terrain provider selects maximum packages at the requested DEM zoom, independently of overlay detail', async t => {
  const { createTerrainElevationReader } = await import('../src/layers/terrain/data');
  const { ElevationTiles } = await import('../src/layers/terrain/elevation');
  const received: unknown[] = [];
  t.mock.method(ElevationTiles.prototype, 'read', async (...args: unknown[]) => {
    received.push(args[3]); return new Float32Array(65536);
  });
  const shard = { zoom: 11, x: 1024, y: 1024, file: `${'a'.repeat(64)}.terrain`, sha256: 'a'.repeat(64), byteLength: 100 };
  const read = createTerrainElevationReader([{ schemaVersion: 1, encoding: 'float32-feet-gzip', minZoom: 1, maxZoom: 13,
    root: '/terrain/', generatedAt: '2026-09-03T00:00:00Z', shards: [shard] }], 'https://charts.test/', 'fallback/{z}/{x}/{y}.png');
  await read({ z: 11, x: 1024, y: 1024 }, new AbortController().signal);
  assert.deepEqual(received, [[{ root: 'https://charts.test/terrain/', shard, priority: 0 }]]);
});

test('route clipping keeps crossing legs and clips merged coverage at 20 NM, including turns and endpoints', () => {
  const view = boundsViewport([-1, -1, 1, 1]);
  const legs: Segment[] = [[project([-10, 0]), project([.3, 0])], [project([.3, 0]), project([.3, .3])]];
  const local = localRouteSegments(legs, view);
  assert.equal(local.length, 2);
  assert.ok(local[0]![0][0] > project([-2, 0])[0]);
  const mask = routeMask(local, view);
  assert.ok(mask.length > 0);
  for (const polygon of mask) for (const ring of polygon) for (const point of ring) {
    assert.ok(insideViewport(point, view));
    assert.ok(inRouteCorridor(point, legs), 'all outline vertices stay within 20 NM');
  }
  assert.deepEqual(routeMask([], view), []);
});

test('masked core DEM only acquires intersecting active tiles and leaves unrequested cells unknown', async () => {
  const bounds: [number, number, number, number] = [-.4, -.4, .4, .4];
  const layout = elevationGridLayout(bounds, 10), mask = new Uint8Array(layout.width * layout.height);
  mask[0] = 1; mask[layout.width * layout.height - 1] = 1;
  const tiles: string[] = [];
  const result = await readElevationGrid(async tile => { tiles.push(`${tile.x}/${tile.y}`); return new Float32Array(65536).fill(100); }, bounds, 10, new AbortController().signal, mask);
  assert.equal(tiles.length, 2);
  assert.equal(result.values.filter(Number.isFinite).length, 2);
  assert.equal(result.values[0], 100);
});

function request(overrides: Partial<GlideRequest> = {}): GlideRequest {
  const bounds: [number, number, number, number] = [-.6, -.6, .6, .6];
  return { id: 1, viewport: boundsViewport(bounds), airports: [airport], altitude: 6500, ratio: 8,
    segments: [[project([-.5, 0]), project([.5, 0])]], ownship: null, sources: [], sourceKey: 'flat', base: 'https://charts.test/', tileUrl: '', ...overrides };
}

test('slider adjustments reuse polar terrain profiles and ownship movement reuses the merged airport plan', async t => {
  let reads = 0;
  const calculator = new GlidePlanner(async () => { reads++; return new Float32Array(65536); });
  const signal = new AbortController().signal, start = performance.now();
  const cold = await calculator.calculate(request({ ownship: [0.03, .03] }), signal);
  const coldMs = performance.now() - start, readsAfterCold = reads, warmStart = performance.now();
  const warm = await calculator.calculate(request({ altitude: 6200, ownship: [0.03, .03] }), signal);
  const warmMs = performance.now() - warmStart;
  assert.ok(cold.areas.features.length && cold.ownship!.line.features.length);
  assert.ok(cold.work.terrainCells > 0 && cold.work.profilesBuilt === 2);
  assert.equal(reads, readsAfterCold); assert.equal(warm.work.terrainCells, 0);
  assert.equal(warm.work.profileCells, 0); assert.equal(warm.work.profilesBuilt, 0); assert.equal(warm.work.profilesReused, 2);
  const moving = await calculator.calculate(request({ altitude: 6200, ownship: [.031, .03] }), signal);
  assert.equal(moving.work.planReused, true); assert.strictEqual(moving.areas, warm.areas);
  assert.equal(moving.work.profilesBuilt, 1);
  t.diagnostic(`Origin DEMs: ${cold.work.terrainCells} cells cold, ${warm.work.terrainCells} warm; profiles ${cold.work.profilesBuilt} cold, ${warm.work.profilesBuilt} warm; ${coldMs.toFixed(1)} ms cold / ${warmMs.toFixed(1)} ms slider (non-gating timing)`);
});

test('a rotated work window masks terrain acquisition and bounds the kernel profile', async () => {
  const center = project([0, 0]), d = .001;
  const viewport: Point[] = [[center[0], center[1] - d], [center[0] + d, center[1]], [center[0], center[1] + d], [center[0] - d, center[1]]];
  const bounds = viewportBounds(viewport);
  let zoom = 11, layout = elevationGridLayout(bounds, zoom);
  while (layout.width * layout.height > 512 * 512) layout = elevationGridLayout(bounds, --zoom);
  let onScreen = 0;
  for (let y = 0; y < layout.height; y++) for (let x = 0; x < layout.width; x++) {
    if (insideViewport([(layout.x + x + .5) / layout.size, (layout.y + y + .5) / layout.size], viewport)) onScreen++;
  }
  const calculator = new GlideCalculator(async tile => {
    const values = new Float32Array(65536);
    let intersects = false;
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      const visible = insideViewport([(tile.x * 256 + x + .5) / layout.size, (tile.y * 256 + y + .5) / layout.size], viewport);
      intersects ||= visible; values[y * 256 + x] = visible ? 0 : NaN;
    }
    assert.ok(intersects, 'no tile wholly outside the visible quad is read'); return values;
  });
  const result = await calculator.calculate({ coordinate: [0, 0], viewport, altitude: 18000, ratio: 20, elevationFt: 0 }, new AbortController().signal);
  assert.equal(result.work.profilesBuilt, 1);
  assert.ok(result.work.terrainCells <= onScreen); assert.ok(result.work.profileCells <= onScreen);
  assert.equal(result.footprint.incomplete, false, 'unknown terrain outside the work window must not constrain the calculation');
  for (const point of result.footprint.polygon.flat()) assert.ok(insideViewport(point as Point, viewport));
});

test('ownship glides outward, stops at intervening terrain and omits false ring edges at viewport limits', () => {
  const terrain = grid(x => x >= 35 && x <= 40 ? 2800 : 0);
  const viewport = boundsViewport([-.2, -.2, .2, .2]);
  const prepared = prepareGlideProfile(project([0, 0]), terrain, viewport, .0005);
  const low = profileFootprint(prepared, 3500, 8);
  assert.ok(low.radii[0]! < low.radii[GLIDE_SECTORS / 2]! * .7, 'forward path must stop at a ridge in the glide path');
  const ring = ownshipOutline(prepared, low.radii);
  assert.ok(ring.features.length);
  const high = profileFootprint(prepared, 18000, 20);
  assert.equal(ownshipOutline(prepared, high.radii).features.length, 0, 'a ring reaching all viewport caps has no on-screen glide limit');
  const tiny = prepareGlideProfile(project([0, 0]), terrain, boundsViewport([-.005, -.005, .05, .05]), .0005);
  const partial = profileFootprint(tiny, 1500, 8), lines = ownshipOutline(tiny, partial.radii);
  assert.ok(lines.features.length);
  for (const line of lines.features[0]!.geometry.coordinates) {
    assert.notDeepEqual(line[0], line.at(-1), 'viewport-clipped paths stay open');
    for (const point of line) assert.ok(insideViewport(project(point as Point), boundsViewport([-.005, -.005, .05, .05])));
  }
});

test('no route and no visible ownship performs no terrain work; cancellation and source changes discard obsolete caches', async () => {
  let reads = 0;
  const calculator = new GlidePlanner(async () => { reads++; return new Float32Array(65536); });
  const controller = new AbortController();
  const empty = await calculator.calculate(request({ segments: [], ownship: [20, 20] }), controller.signal);
  assert.equal(reads, 0); assert.equal(empty.airports.length, 0); assert.equal(empty.work.profilesBuilt, 0);
  await calculator.calculate(request(), controller.signal);
  const before = reads;
  await calculator.calculate(request({ sourceKey: 'replacement-source' }), controller.signal);
  assert.ok(reads > before);
  controller.abort();
  await assert.rejects(calculator.calculate(request(), controller.signal), { name: 'AbortError' });
});

test('range expansion leaves enough sampled halo for whole planning cells without false missing-terrain status', async () => {
  const bounds: [number, number, number, number] = [-.14, -.14, .14, .14];
  const calculator = new GlidePlanner(async () => new Float32Array(65536));
  for (const ratio of [3, 8, 20]) for (const altitude of [600, 1500, 2800, 4400, 6500, 18000]) {
    const result = await calculator.calculate(request({ viewport: boundsViewport(bounds), ratio, altitude, ownship: [0, 0] }), new AbortController().signal);
    assert.equal(result.incomplete, false, `${altitude} ft, ${ratio}:1 airport coverage`);
    assert.equal(result.ownship!.incomplete, false, `${altitude} ft, ${ratio}:1 ownship coverage`);
  }
});

test('a selected map point uses forward glide independently of routes/GPS and retains other cached origins', async () => {
  const calculator = new GlidePlanner(async () => new Float32Array(65536));
  const signal = new AbortController().signal;
  const selectedOnly = await calculator.calculate(request({ segments: [], ownship: null, point: [.01, 0] }), signal);
  assert.equal(selectedOnly.areas.features.length, 0);
  assert.equal(selectedOnly.ownship, null);
  assert.equal(selectedOnly.point!.line.features.length, 1);
  assert.equal(selectedOnly.point!.area.features.length, 1);
  assert.equal(selectedOnly.point!.incomplete, false);
  const together = await calculator.calculate(request({ ownship: [.02, 0], point: [.01, 0] }), signal);
  assert.ok(together.areas.features.length && together.ownship!.area.features.length && together.point!.area.features.length);
  const moved = await calculator.calculate(request({ ownship: [.02, 0], point: [.015, 0] }), signal);
  assert.equal(moved.work.planReused, true); assert.equal(moved.work.profilesBuilt, 1); assert.equal(moved.work.footprintsReused, 2);
  assert.deepEqual(moved.ownship, together.ownship);
  const cleared = await calculator.calculate(request({ ownship: [.02, 0], point: null }), signal);
  assert.equal(cleared.point, null);
  assert.equal(cleared.work.planReused, true); assert.equal(cleared.work.profilesBuilt, 0);
  const outside = await calculator.calculate(request({ ownship: [.02, 0], point: [20, 20] }), signal);
  assert.equal(outside.point, null); assert.equal(outside.work.terrainCells, 0); assert.equal(outside.work.profilesBuilt, 0);
});

test('selected-point terrain failures remain separate and never produce optimistic filled circles', async () => {
  const calculator = new GlidePlanner(async () => { throw new Error('missing'); });
  const result = await calculator.calculate(request({ airports: [], segments: [], point: [.01, 0] }), new AbortController().signal);
  assert.equal(result.point!.incomplete, true); assert.equal(result.incomplete, false); assert.equal(result.ownship, null);
  assert.equal(result.point!.line.features.length, 0); assert.equal(result.point!.area.features.length, 0);
});
