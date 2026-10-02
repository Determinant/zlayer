import assert from 'node:assert/strict';
import test from 'node:test';
import type { Bounds, GeoPointFeature } from '@zlayer/contracts';
import { project, type Point } from '../src/core/geo/route-corridor';
import { glideAirport } from '../src/layers/glide/airports';
import { boundsViewport, insideViewport, inRouteCorridor } from '../src/layers/glide/coverage';
import { GlidePlanner } from '../src/layers/glide/planner';
import type { GlideAirport, GlideRequest } from '../src/layers/glide/types';

function airport(lng = 0, id = String(lng)): GlideAirport {
  const feature: GeoPointFeature = { type: 'Feature', id, geometry: { type: 'Point', coordinates: [lng, 0] },
    properties: { kind: 'landing-facility', faaId: id, facilityType: 'AIRPORT', status: 'O', use: 'PR', elevationFt: 0,
      runways: [{ id: '09/27', lengthFt: 1800, surface: 'TURF' }] } };
  return glideAirport(feature)!;
}
function request(overrides: Partial<GlideRequest> = {}): GlideRequest {
  const bounds: Bounds = [-.025, -.025, .025, .025];
  return { id: 1, viewport: boundsViewport(bounds), airports: [airport()], altitude: 6500, ratio: 8,
    segments: [[project([-2, 0]), project([2, 0])]], ownship: null, point: null,
    sources: [], sourceKey: 'terrain', airportKey: 'navigation', base: 'https://charts.test/', tileUrl: '', ...overrides };
}
const signal = () => new AbortController().signal;

test('complete airport footprints survive pan, rotation and zoom without more terrain work', async () => {
  let reads = 0;
  const planner = new GlidePlanner(async () => { reads++; return new Float32Array(65536); });
  const initial = request(), first = await planner.calculate(initial, signal()), coldReads = reads;
  assert.equal(first.airports.length, 1); assert.equal(first.incomplete, false);
  assert.ok(first.areas.features.flatMap(f => f.geometry.coordinates.flat(2)).some(p => !insideViewport(project(p as Point), initial.viewport)),
    'the initial footprint completes beyond the camera edge');
  for (const viewport of [boundsViewport([-.001, -.001, .001, .001]), boundsViewport([-.5, -.5, .5, .5]),
    boundsViewport([1, 1, 1.2, 1.2]), [project([-.1, 0]), project([0, -.1]), project([.1, 0]), project([0, .1])]]) {
    const result = await planner.calculate(request({ viewport, airports: [] }), signal());
    assert.strictEqual(result.areas, first.areas); assert.deepEqual(result.airports, first.airports);
    assert.equal(result.work.terrainCells, 0); assert.equal(result.work.profilesBuilt, 0); assert.equal(result.work.planReused, true);
  }
  const revisit = await planner.calculate(initial, signal());
  assert.equal(revisit.work.footprintsReused, 1); assert.equal(reads, coldReads);
});

test('visiting another airport accumulates merged coverage inside the route corridor', async () => {
  const planner = new GlidePlanner(async () => new Float32Array(65536));
  const first = await planner.calculate(request(), signal());
  const next = await planner.calculate(request({ viewport: boundsViewport([.025, -.01, .035, .01]), airports: [airport(.03)] }), signal());
  assert.equal(next.airports.length, 2); assert.equal(next.areas.features[0]!.geometry.coordinates.length, 1, 'overlapping cached footprints fuse');
  assert.ok(next.areas.features[0]!.geometry.coordinates[0]!.flat().some(p => p[0]! >
    Math.max(...first.areas.features[0]!.geometry.coordinates.flat(2).map(p => p[0]!))));
  for (const point of next.areas.features.flatMap(f => f.geometry.coordinates.flat(2))) assert.ok(inRouteCorridor(project(point as Point), request().segments));
  const distant = await planner.calculate(request({ viewport: boundsViewport([.79, -.01, .81, .01]), airports: [airport(.8)] }), signal());
  assert.equal(distant.airports.length, 3); assert.equal(distant.areas.features[0]!.geometry.coordinates.length, 2);
});

test('cached airport unions retain date-line wrapping when origins are visited from either side', async () => {
  const planner = new GlidePlanner(async () => new Float32Array(65536));
  const crossing = request({ viewport: boundsViewport([179.9, -.1, 180.1, .1]),
    segments: [[project([179.5, 0]), project([180.5, 0])]], airports: [airport(179.98)] });
  await planner.calculate(crossing, signal());
  const result = await planner.calculate({ ...crossing, airports: [airport(-179.98)] }, signal());
  assert.equal(result.airports.length, 2); assert.equal(result.areas.features[0]!.geometry.coordinates.length, 2);
  for (const polygon of result.areas.features[0]!.geometry.coordinates) for (const ring of polygon) {
    for (let i = 1; i < ring.length; i++) assert.ok(Math.abs(ring[i]![0]! - ring[i - 1]![0]!) < 1, 'cached coverage crossed the whole world');
  }
  const revisited = await planner.calculate({ ...crossing, viewport: boundsViewport([-180.1, -.1, -179.9, .1]) }, signal());
  assert.strictEqual(revisited.areas, result.areas); assert.equal(revisited.work.terrainCells, 0);
});

test('route removal hides airports; altitude, ratio, navigation and terrain changes invalidate their coverage', async () => {
  let reads = 0;
  const planner = new GlidePlanner(async () => { reads++; return new Float32Array(65536); });
  const first = await planner.calculate(request(), signal());
  const warm = await planner.calculate(request({ altitude: 6200 }), signal());
  assert.equal(warm.work.terrainCells, 0); assert.equal(warm.work.profilesBuilt, 0); assert.equal(warm.work.profilesReused, 1);
  assert.notDeepEqual(warm.areas, first.areas);
  for (const change of [{ segments: [] }, { altitude: 5000 }, { ratio: 7 }, { airportKey: 'replacement' }]) {
    await planner.calculate(request(), signal());
    const result = await planner.calculate(request({ ...change, airports: [] }), signal());
    assert.equal(result.airports.length, 0); assert.equal(result.areas.features.length, 0);
  }
  const before = reads;
  const replaced = await planner.calculate(request({ sourceKey: 'replacement-terrain' }), signal());
  assert.equal(replaced.airports.length, 1); assert.ok(reads > before); assert.equal(replaced.work.profilesBuilt, 1);
});

test('route edits reclip complete visited footprints off screen without terrain work or discovery', async () => {
  let reads = 0;
  const planner = new GlidePlanner(async () => { reads++; return new Float32Array(65536); });
  const start = request({ altitude: 18000, ratio: 20, ownship: [0, 0], point: [0, 0] });
  const first = await planner.calculate(start, signal()), initialReads = reads;
  const north = (result: typeof first) => Math.max(...result.areas.features.flatMap(f => f.geometry.coordinates.flat(2)).map(p => p[1]!));
  const outside = { ...start, viewport: boundsViewport([.5, -.1, .7, .1]), airports: [airport(.6)], discover: false };
  const shifted = await planner.calculate({ ...outside, segments: [[project([-2, .2]), project([2, .2])]] }, signal());
  assert.equal(shifted.airports.length, 1, 'retain the visited off-screen airport; do not discover the new visible one');
  assert.ok(north(shifted) > north(first) + .1, 'reclip the complete footprint, not its previous route-clipped subset');
  assert.strictEqual(shifted.ownship, first.ownship); assert.strictEqual(shifted.point!.area, first.point!.area);
  for (const p of shifted.areas.features.flatMap(f => f.geometry.coordinates.flat(2))) {
    assert.ok(inRouteCorridor(project(p as Point), [[project([-2, .2]), project([2, .2])]]));
  }
  for (const segments of [[], [[project([-2, 1]), project([2, 1])]]]) {
    const removed = await planner.calculate({ ...outside, segments: segments as GlideRequest['segments'] }, signal());
    assert.equal(removed.airports.length, 0); assert.equal(removed.areas.features.length, 0);
    assert.strictEqual(removed.ownship, first.ownship); assert.strictEqual(removed.point, first.point);
  }
  const restored = await planner.calculate(outside, signal());
  assert.deepEqual(restored.areas, first.areas); assert.deepEqual(restored.airports, first.airports);
  assert.equal(reads, initialReads);
  assert.equal(restored.work.terrainCells, 0); assert.equal(restored.work.profilesBuilt, 0);
});

test('overview reconciliation cannot acquire new forward origins or retain ranges for obsolete inputs', async () => {
  let reads = 0;
  const planner = new GlidePlanner(async () => { reads++; return new Float32Array(65536); });
  const start = request({ ownship: [0, 0], point: [0, 0] });
  await planner.calculate(start, signal());
  const initialReads = reads;
  const moved = await planner.calculate({ ...start, discover: false, ownship: [.01, 0], point: [.02, 0] }, signal());
  assert.equal(moved.ownship, null); assert.equal(moved.point, null);
  assert.equal(moved.airports.length, 1);
  for (const change of [{ altitude: 5000 }, { ratio: 7 }, { airportKey: 'new-navigation' }, { sourceKey: 'new-terrain' }]) {
    const result = await planner.calculate({ ...start, ...change, discover: false }, signal());
    assert.equal(result.areas.features.length, 0);
  }
  assert.equal(reads, initialReads);
});

test('forward ranges retain complete geometry off screen and never follow an obsolete origin', async () => {
  const planner = new GlidePlanner(async () => new Float32Array(65536));
  const start = request({ airports: [], segments: [], ownship: [0, 0], point: [.01, 0] });
  const first = await planner.calculate(start, signal());
  for (const ring of [first.ownship!.line, first.point!.line]) {
    assert.equal(ring.features.length, 1);
    const path = ring.features[0]!.geometry.coordinates[0]!;
    assert.deepEqual(path[0], path.at(-1), 'the camera cannot truncate a full forward range');
  }
  const outside = await planner.calculate({ ...start, viewport: boundsViewport([1, 1, 1.1, 1.1]) }, signal());
  assert.strictEqual(outside.ownship, first.ownship); assert.strictEqual(outside.point!.area, first.point!.area);
  assert.equal(outside.work.terrainCells, 0); assert.equal(outside.work.footprintsReused, 2);
  const changed = await planner.calculate({ ...start, ownship: [.005, 0], point: null }, signal());
  assert.notDeepEqual(changed.ownship, first.ownship); assert.equal(changed.point, null);
  const newOffscreen = await planner.calculate({ ...start, ownship: [10, 0], point: [10, 0] }, signal());
  assert.equal(newOffscreen.ownship, null); assert.equal(newOffscreen.point, null);
  assert.equal(newOffscreen.work.terrainCells, 0);
});

test('terrain-buffer eviction keeps finished geometry; airport geometry uses a bounded LRU', async () => {
  const planner = new GlidePlanner(async () => new Float32Array(65536), { airports: 2, geometryBytes: 100_000, residentBytes: 1 });
  const first = await planner.calculate(request(), signal());
  const cached = await planner.calculate(request(), signal());
  assert.strictEqual(cached.areas, first.areas); assert.equal(cached.work.terrainCells, 0);
  const changeAltitude = await planner.calculate(request({ altitude: 6200 }), signal());
  assert.equal(changeAltitude.work.profilesBuilt, 1, 'numeric cache obeys its independent budget');
  await planner.calculate(request(), signal());
  await planner.calculate(request({ airports: [airport(.01)] }), signal());
  await planner.calculate(request(), signal()); // Touch airport zero, making .01 the oldest.
  const third = await planner.calculate(request({ airports: [airport(.02)] }), signal());
  assert.deepEqual(third.airports.map(a => a.properties.faaId), ['0', '0.02']);
  const evicted = await planner.calculate(request({ airports: [airport(.01)] }), signal());
  assert.equal(evicted.work.profilesBuilt, 1); assert.equal(evicted.airports.length, 2);
});

test('unknown terrain and cancellation never enter the cache as successful coverage', async () => {
  const missing = new GlidePlanner(async () => { throw new Error('missing'); });
  const partial = await missing.calculate(request({ ownship: [0, 0], point: [0, 0] }), signal());
  assert.equal(partial.incomplete, true); assert.equal(partial.areas.features.length, 0);
  assert.equal(partial.ownship!.incomplete, true); assert.equal(partial.point!.incomplete, true);
  assert.equal(partial.ownship!.line.features.length, 0); assert.equal(partial.point!.area.features.length, 0);
  const controller = new AbortController();
  const planner = new GlidePlanner(async () => { controller.abort(); return new Float32Array(65536); });
  await assert.rejects(planner.calculate(request(), controller.signal), { name: 'AbortError' });
  const next = await planner.calculate(request({ airports: [] }), signal());
  assert.equal(next.airports.length, 0); assert.equal(next.areas.features.length, 0);
});
