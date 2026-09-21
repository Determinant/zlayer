import assert from 'node:assert/strict';
import test from 'node:test';
import type { FeatureCollection } from 'geojson';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { RoutePlan } from '@zlayer/domain';
import { createRouteLayer } from '../src/layers/routes/layer';
import { RECOMMENDATION_SOURCE_ID, ROUTE_SOURCE_ID, ROUTE_DRAG_SOURCE_ID, syncRoute, type RouteDragPreview } from '../src/layers/routes/renderer';
import type { RoutePreview } from '../src/layers/routes/map-preview';
import { createRouteRemovalResolver } from './helpers/route-removal';
import { ROUTE_LABEL_IDS_STATE } from '../src/core/map/label';

function fixture(t: test.TestContext) {
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  for (const [name, value] of Object.entries({
    requestAnimationFrame: (callback: FrameRequestCallback) => { const id = nextFrame++; frames.set(id, callback); return id; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
  })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, name, original) : Reflect.deleteProperty(globalThis, name));
  }
  const sources = new Map<string, FeatureCollection>();
  const layers = new Set<string>(), images = new Set<string>();
  const writes: string[] = [], labels: unknown[] = [];
  const handlers = new Map<string, () => void>();
  const state = new Map<string, unknown>(), hiddenLegs = new Set<string>();
  let dragLoaded = true, dragTiles: FeatureCollection | undefined;
  const map = {
    addSource(id: string, source: { data: FeatureCollection }) { sources.set(id, source.data); },
    getSource: (id: string) => sources.has(id) ? { setData(data: FeatureCollection) {
      sources.set(id, data); writes.push(id);
      if (id === ROUTE_DRAG_SOURCE_ID && dragLoaded) dragTiles = data;
    } } : undefined,
    on: (name: string, handler: () => void) => handlers.set(name, handler),
    off: (name: string) => handlers.delete(name),
    isSourceLoaded: () => dragLoaded,
    querySourceFeatures: (_id: string, options: { filter: unknown[] }) =>
      dragTiles?.features.filter(feature => feature.properties?.dragPreviewKey === options.filter[2]) ?? [],
    setFeatureState: ({ id }: { id: string }) => hiddenLegs.add(id),
    removeFeatureState: ({ id }: { id: string }) => {
      assert.ok(hiddenLegs.delete(id), 'pending previews have no feature state to remove');
    },
    removeSource: (id: string) => sources.delete(id),
    addLayer: (layer: { id: string }) => layers.add(layer.id), getLayer: (id: string) => layers.has(id),
    removeLayer: (id: string) => layers.delete(id),
    addImage: (id: string) => images.add(id), hasImage: (id: string) => images.has(id), removeImage: (id: string) => images.delete(id),
    setGlobalStateProperty: (name: string, value: unknown) => {
      state.set(name, value);
      if (name === ROUTE_LABEL_IDS_STATE) labels.push(value);
    },
  } as unknown as MapLibreMap;
  const layer = createRouteLayer();
  const flush = () => {
    const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0));
    handlers.get('render')?.();
  };
  const reset = () => { writes.length = 0; labels.length = 0; };
  const assertCurrent = (route: RoutePlan, preview?: RouteDragPreview, recommendations?: RoutePreview) => {
    const expected = new Map<string, FeatureCollection>();
    syncRoute({ setGlobalStateProperty() {}, getSource: (id: string) => ({ setData: (data: FeatureCollection) => expected.set(id, data) }) } as unknown as MapLibreMap,
      route, preview, recommendations);
    assert.deepEqual(sources, expected, 'cached rendering must equal a fresh render of the latest input');
  };
  t.after(() => layer.unmount());
  return { layer, map, sources, writes, labels, frames, flush, reset, assertCurrent, hiddenLegs, handlers,
    dragVisible: () => state.get('zlayer-route-drag-visible'),
    delayDrag: () => { dragLoaded = false; },
    completeDrag: () => { dragLoaded = true; dragTiles = sources.get(ROUTE_DRAG_SOURCE_ID); flush(); },
    failDrag: () => { dragLoaded = true; flush(); },
  };
}

test('drag previews submit immediately without resubmitting alternatives, labels, or identical snapped coordinates', t => {
  const f = fixture(t), route = createRouteRemovalResolver()('KSBA ENTRY EXIT KSMX');
  f.layer.update({ route }); f.layer.mount(f.map); f.reset();
  let preview: RouteDragPreview;
  for (let i = 0; i < 20; i++) {
    preview = { target: route.legs[0]!.edit!, revision: route.revision, coordinate: [-120 + i / 100, 35], snapped: false };
    f.layer.update({ route, preview });
    f.flush();
    f.assertCurrent(route, preview);
  }
  assert.equal(f.frames.size, 0, 'worker submission must not wait for an animation frame');
  assert.deepEqual(f.writes, Array<string>(20).fill(ROUTE_DRAG_SOURCE_ID));
  f.flush();
  assert.deepEqual(f.labels, []);
  f.assertCurrent(route, preview!);
  f.reset();
  f.layer.update({ route, preview: { ...preview!, target: { ...preview!.target }, coordinate: [...preview!.coordinate] } });
  f.flush();
  assert.deepEqual(f.writes, [], 'equivalent preview objects do not cause new source work');
  preview = { ...preview!, snapped: true };
  f.layer.update({ route, preview }); f.flush();
  assert.deepEqual(f.writes, [ROUTE_DRAG_SOURCE_ID], 'snap styling updates even at identical coordinates');
  f.assertCurrent(route, preview);
  preview = { ...preview, target: route.waypoints[1]!.edit! };
  f.layer.update({ route, preview }); f.flush(); f.assertCurrent(route, preview);
  f.reset();
  f.layer.update({ route, preview: { ...preview, coordinate: [-117, 36] } });
  f.reset();
  f.layer.update({ route });
  assert.equal(f.frames.size, 0);
  f.assertCurrent(route);
  assert.deepEqual(f.writes, [ROUTE_SOURCE_ID], 'the ordinary route is restored synchronously');
  f.flush(); f.assertCurrent(route);
});

test('new revisions, cancellation, and detach cannot publish an obsolete drag', t => {
  const f = fixture(t), resolve = createRouteRemovalResolver(), route = resolve('KSBA ENTRY EXIT KSMX');
  const preview: RouteDragPreview = { target: route.waypoints[1]!.edit!, revision: route.revision, coordinate: [-117, 36], snapped: true };
  f.layer.update({ route }); f.layer.mount(f.map); f.reset();
  f.layer.update({ route, preview }); f.layer.update({ route }); f.flush();
  assert.deepEqual(f.writes, [ROUTE_SOURCE_ID, ROUTE_SOURCE_ID], 'both preview and cancellation submit immediately');
  f.assertCurrent(route);
  f.layer.update({ route, preview });
  const next = resolve('KSBA ENTRY EXIT KSMX');
  f.layer.update({ route: next });
  assert.equal(f.frames.size, 0);
  f.assertCurrent(next); f.flush(); f.assertCurrent(next);
  f.reset();
  f.layer.update({ route: next, preview }); f.flush();
  assert.deepEqual(f.writes, [], 'a preview from an old revision cannot change geometry');
  f.layer.update({ route: next, preview: { ...preview, revision: next.revision } });
  f.layer.unmount();
  assert.equal(f.frames.size, 0);
  f.flush(); assert.equal(f.sources.size, 0);
  f.layer.update({ route: next }); f.layer.mount(f.map);
  f.assertCurrent(next);
});

test('moving a leg in a large route only submits the bend and marker after acquisition', t => {
  const f = fixture(t), route = createRouteRemovalResolver()(`KSBA ${Array(250).fill('ENTRY EXIT').join(' ')} KSMX`);
  assert.ok(route.legs.length > 500);
  f.layer.update({ route }); f.layer.mount(f.map);
  const preview: RouteDragPreview = { target: route.legs[250]!.edit!, revision: route.revision, coordinate: [-119, 35], snapped: false };
  f.layer.update({ route, preview });
  f.flush();
  const stationary = f.sources.get(ROUTE_SOURCE_ID)!;
  assert.equal(stationary.features.length, route.legs.length + route.waypoints.length);
  f.reset();
  for (let i = 1; i <= 100; i++) {
    f.layer.update({ route, preview: { ...preview, coordinate: [-119 + i / 1000, 35] } });
    assert.equal(f.sources.get(ROUTE_SOURCE_ID), stationary, 'the large source is neither rebuilt nor resubmitted');
    const moving = f.sources.get(ROUTE_DRAG_SOURCE_ID)!;
    assert.equal(moving.features.length, 2);
    assert.deepEqual(moving.features.map(feature => feature.geometry.type), ['LineString', 'Point']);
  }
  assert.deepEqual(f.writes, Array<string>(100).fill(ROUTE_DRAG_SOURCE_ID));
  assert.deepEqual(f.labels, []);
  f.reset();
  f.layer.update({ route });
  assert.deepEqual(f.writes, [ROUTE_DRAG_SOURCE_ID]);
  assert.equal(f.sources.get(ROUTE_DRAG_SOURCE_ID)!.features.length, 0);
  f.assertCurrent(route);
});

test('the original leg stays visible until preview tiles load, and movement during loading coalesces', t => {
  const f = fixture(t), route = createRouteRemovalResolver()('KSBA ENTRY EXIT KSMX');
  const preview: RouteDragPreview = { target: route.legs[0]!.edit!, revision: route.revision, coordinate: [-119, 35], snapped: false };
  f.layer.update({ route }); f.layer.mount(f.map); f.reset();
  const original = f.sources.get(ROUTE_SOURCE_ID);
  f.delayDrag();
  f.layer.update({ route, preview });
  const latest = { ...preview, coordinate: [-118, 36] as [number, number] };
  for (let i = 0; i < 20; i++) {
    f.layer.update({ route, preview: latest }); f.flush();
    assert.equal(f.dragVisible(), false);
    assert.equal(f.hiddenLegs.size, 0);
  }
  assert.deepEqual(f.writes, [ROUTE_DRAG_SOURCE_ID], 'loading must not be starved by continuous updates');
  f.completeDrag();
  assert.equal(f.dragVisible(), true);
  assert.deepEqual([...f.hiddenLegs], [`${route.revision}:token:0`]);
  assert.deepEqual(f.writes, [ROUTE_DRAG_SOURCE_ID, ROUTE_DRAG_SOURCE_ID]);
  f.assertCurrent(route, latest);
  f.delayDrag(); f.reset();
  f.layer.update({ route });
  assert.equal(f.dragVisible(), false, 'cancellation does not wait for source processing');
  assert.equal(f.hiddenLegs.size, 0);
  assert.equal(f.sources.get(ROUTE_SOURCE_ID), original);
  assert.deepEqual(f.writes, [ROUTE_DRAG_SOURCE_ID]);
  f.completeDrag();
  assert.equal(f.dragVisible(), false, 'late completion cannot revive a cancelled drag');
});

for (const change of ['cancel', 'revision', 'target', 'detach'] as const) test(`pending preview completion after ${change} cannot hide the wrong leg`, t => {
  const f = fixture(t), resolve = createRouteRemovalResolver(), route = resolve('KSBA ENTRY EXIT KSMX');
  const preview: RouteDragPreview = { target: route.legs[0]!.edit!, revision: route.revision, coordinate: [-119, 35], snapped: false };
  f.layer.update({ route }); f.layer.mount(f.map);
  f.delayDrag(); f.layer.update({ route, preview });
  if (change === 'cancel') f.layer.update({ route });
  if (change === 'revision') f.layer.update({ route: resolve('KSBA ENTRY EXIT KSMX'), preview });
  if (change === 'target') f.layer.update({ route, preview: { ...preview, target: route.legs[1]!.edit! } });
  if (change === 'detach') { f.layer.unmount(); assert.equal(f.handlers.size, 0); }
  f.completeDrag();
  assert.equal(f.dragVisible(), change === 'target');
  assert.deepEqual([...f.hiddenLegs], change === 'target' ? [`${route.revision}:token:1`] : []);
});

test('an errored load retaining an old preview cannot replace the original leg', t => {
  const f = fixture(t), route = createRouteRemovalResolver()('KSBA ENTRY EXIT KSMX');
  const preview: RouteDragPreview = { target: route.legs[0]!.edit!, revision: route.revision, coordinate: [-119, 35], snapped: false };
  f.layer.update({ route, preview }); f.layer.mount(f.map); f.flush();
  assert.equal(f.dragVisible(), true);
  f.delayDrag(); f.layer.update({ route });
  f.layer.update({ route, preview: { ...preview, coordinate: [-118, 36] } });
  f.failDrag();
  assert.equal(f.dragVisible(), false);
  assert.equal(f.hiddenLegs.size, 0);
  f.completeDrag();
  assert.equal(f.dragVisible(), true);
});

for (const change of ['revision', 'comparison', 'target', 'detach'] as const) test(`a leg preview is cleared or replaced on ${change}`, t => {
  const f = fixture(t), resolve = createRouteRemovalResolver(), route = resolve('KSBA ENTRY EXIT KSMX');
  const preview: RouteDragPreview = { target: route.legs[0]!.edit!, revision: route.revision, coordinate: [-119, 35], snapped: true };
  f.layer.update({ route, preview }); f.layer.mount(f.map);
  assert.equal(f.sources.get(ROUTE_DRAG_SOURCE_ID)!.features.length, 2);
  if (change === 'revision') {
    const next = resolve('KSBA ENTRY EXIT KSMX');
    f.layer.update({ route: next, preview });
    f.assertCurrent(next);
  } else if (change === 'comparison') {
    const comparison = { selectedKey: 'route', routes: [{ key: 'route', plan: route }] };
    f.layer.update({ route, preview, comparison });
    f.assertCurrent(route, undefined, comparison);
  } else if (change === 'target') {
    const next = { ...preview, target: route.legs[1]!.edit! };
    f.layer.update({ route, preview: next });
    f.assertCurrent(route, next);
    assert.equal(f.sources.get(ROUTE_DRAG_SOURCE_ID)!.features.length, 2);
    return;
  } else {
    f.layer.unmount();
    assert.equal(f.sources.size, 0);
    f.layer.update({ route }); f.layer.mount(f.map);
    f.assertCurrent(route);
  }
  assert.equal(f.sources.get(ROUTE_DRAG_SOURCE_ID)!.features.length, 0);
});

test('recommendation changes independently update primary and alternative sources and restore editing', t => {
  const f = fixture(t), resolve = createRouteRemovalResolver(), route = resolve('KSBA ENTRY EXIT KSMX');
  const other = resolve('KSBA DEP1 KSMX'), third = resolve('KSBA TEST1 KSMX');
  let recommendations: RoutePreview = { selectedKey: 'first', routes: [{ key: 'first', plan: route }, { key: 'second', plan: other }] };
  f.layer.update({ route }); f.layer.mount(f.map); f.reset();
  f.layer.update({ route, comparison: recommendations }); f.assertCurrent(route, undefined, recommendations);
  assert.deepEqual(f.writes, [ROUTE_SOURCE_ID, RECOMMENDATION_SOURCE_ID], 'the same primary becomes read-only');
  assert.deepEqual(f.labels, [], 'unchanged labels retain their identity');
  f.reset();
  recommendations = { ...recommendations, routes: recommendations.routes.map(item => ({ ...item })) };
  f.layer.update({ route, comparison: recommendations });
  assert.deepEqual(f.writes, [], 'equivalent comparison wrappers are a no-op');
  recommendations = { ...recommendations, routes: [...recommendations.routes, { key: 'third', plan: third }] };
  f.layer.update({ route, comparison: recommendations });
  assert.deepEqual(f.writes, [RECOMMENDATION_SOURCE_ID]);
  f.assertCurrent(route, undefined, recommendations);
  recommendations = { ...recommendations, selectedKey: 'second' };
  f.layer.update({ route, comparison: recommendations }); f.assertCurrent(route, undefined, recommendations);
  f.reset();
  f.layer.update({ route }); f.assertCurrent(route);
  assert.deepEqual(f.writes, [ROUTE_SOURCE_ID, RECOMMENDATION_SOURCE_ID]);
  assert.equal(f.sources.get(RECOMMENDATION_SOURCE_ID)!.features.length, 0);
});
