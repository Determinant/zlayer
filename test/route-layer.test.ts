import assert from 'node:assert/strict';
import test from 'node:test';
import type { FeatureCollection } from 'geojson';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { RoutePlan } from '@zlayer/domain';
import { createRouteLayer } from '../src/layers/routes/layer';
import { RECOMMENDATION_SOURCE_ID, ROUTE_SOURCE_ID, syncRoute, type RouteDragPreview } from '../src/layers/routes/renderer';
import type { RoutePreview } from '../src/layers/routes/map-preview';
import { createRouteRemovalResolver } from './helpers/route-removal';

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
  const map = {
    addSource(id: string, source: { data: FeatureCollection }) { sources.set(id, source.data); },
    getSource: (id: string) => sources.has(id) ? { setData(data: FeatureCollection) { sources.set(id, data); writes.push(id); } } : undefined,
    removeSource: (id: string) => sources.delete(id),
    addLayer: (layer: { id: string }) => layers.add(layer.id), getLayer: (id: string) => layers.has(id),
    removeLayer: (id: string) => layers.delete(id),
    addImage: (id: string) => images.add(id), hasImage: (id: string) => images.has(id), removeImage: (id: string) => images.delete(id),
    setGlobalStateProperty: (_name: string, value: unknown) => labels.push(value),
  } as unknown as MapLibreMap;
  const layer = createRouteLayer();
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); };
  const reset = () => { writes.length = 0; labels.length = 0; };
  const assertCurrent = (route: RoutePlan, preview?: RouteDragPreview, recommendations?: RoutePreview) => {
    const expected = new Map<string, FeatureCollection>();
    syncRoute({ setGlobalStateProperty() {}, getSource: (id: string) => ({ setData: (data: FeatureCollection) => expected.set(id, data) }) } as unknown as MapLibreMap,
      route, preview, recommendations);
    assert.deepEqual(sources, expected, 'cached rendering must equal a fresh render of the latest input');
  };
  t.after(() => layer.unmount());
  return { layer, map, sources, writes, labels, frames, flush, reset, assertCurrent };
}

test('drag previews submit immediately without resubmitting alternatives, labels, or identical snapped coordinates', t => {
  const f = fixture(t), route = createRouteRemovalResolver()('KSBA ENTRY EXIT KSMX');
  f.layer.update({ route }); f.layer.mount(f.map); f.reset();
  let preview: RouteDragPreview;
  for (let i = 0; i < 20; i++) {
    preview = { target: route.legs[0]!.edit!, revision: route.revision, coordinate: [-120 + i / 100, 35], snapped: false };
    f.layer.update({ route, preview });
    f.assertCurrent(route, preview);
  }
  assert.equal(f.frames.size, 0, 'worker submission must not wait for an animation frame');
  assert.deepEqual(f.writes, Array<string>(20).fill(ROUTE_SOURCE_ID));
  f.flush();
  assert.deepEqual(f.labels, []);
  f.assertCurrent(route, preview!);
  f.reset();
  f.layer.update({ route, preview: { ...preview!, target: { ...preview!.target }, coordinate: [...preview!.coordinate] } });
  f.flush();
  assert.deepEqual(f.writes, [], 'equivalent preview objects do not cause new source work');
  preview = { ...preview!, snapped: true };
  f.layer.update({ route, preview }); f.flush();
  assert.deepEqual(f.writes, [ROUTE_SOURCE_ID], 'snap styling updates even at identical coordinates');
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
