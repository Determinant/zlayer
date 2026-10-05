import assert from 'node:assert/strict';
import test from 'node:test';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { createNotamChartLayer, NOTAM_CHART_SOURCE } from '../src/layers/notams/map';
import { notice, NOTAM_NOW } from './fixtures/notams';
import { notamChartKey } from '../src/layers/notams/chart';

const record = notice({ text: 'OBST CRANE (ASN UNKNOWN) 370015N1220015W (1NM E TST) 350FT (200FT AGL) FLAGGED' });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function setup(t: test.TestContext) {
  const context = new Proxy({}, { get: (_target, key) => key === 'getImageData' ? () => ({}) : () => {} });
  for (const [key, value] of Object.entries({ document: { createElement: () => ({ getContext: () => context }) },
    Path2D: function() { return new Proxy({}, { get: () => () => {} }); } })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (original) Object.defineProperty(globalThis, key, original); else Reflect.deleteProperty(globalThis, key); });
  }
  const layers = new Set<string>(), images = new Set<string>(), sources = new Set<string>();
  const listeners = new Set<(e: unknown) => void>();
  const writes: { data: FeatureCollection; resolve(): void; reject(error: unknown): void }[] = [];
  let visibility = 'none';
  const source = { setData: (data: FeatureCollection) => new Promise<void>((resolve, reject) => writes.push({ data, resolve, reject })) };
  const map = {
    addSource(id: string) { sources.add(id); }, getSource: (id: string) => sources.has(id) ? source : undefined,
    addLayer(layer: { id: string }) { layers.add(layer.id); }, getLayer: (id: string) => layers.has(id),
    setLayoutProperty(_id: string, _key: string, value: string) { visibility = value; },
    addImage(id: string) { images.add(id); }, hasImage: (id: string) => images.has(id),
    removeImage: (id: string) => images.delete(id), removeSource: (id: string) => sources.delete(id), removeLayer: (id: string) => layers.delete(id),
    on(_type: string, listener: (e: unknown) => void) { listeners.add(listener); },
    off(_type: string, listener: (e: unknown) => void) { listeners.delete(listener); },
  } as unknown as MapLibreMap;
  let shown: readonly string[] = [];
  const layer = createNotamChartLayer(keys => { shown = keys; });
  layer.update({ records: [record], now: NOTAM_NOW }); layer.mount(map);
  t.after(() => layer.unmount());
  return { layer, map, writes, layers, images, sources, listeners, visibility: () => visibility, shown: () => shown };
}

test('stowing hides immediately and a delayed populated source cannot reveal old markers', async t => {
  const h = setup(t);
  assert.equal(h.writes[0]!.data.features.length, 1);
  h.layer.update({ records: [], now: NOTAM_NOW });
  assert.equal(h.visibility(), 'none');
  assert.deepEqual(h.shown(), []);
  h.writes[0]!.resolve(); await flush();
  assert.equal(h.visibility(), 'none'); assert.equal(h.writes[1]!.data.features.length, 0);
  h.writes[1]!.resolve(); await flush(); assert.equal(h.visibility(), 'none');
  h.layer.update({ records: [record], now: NOTAM_NOW });
  h.writes[2]!.resolve(); await flush(); assert.equal(h.visibility(), 'visible');
  assert.deepEqual(h.shown(), [notamChartKey(record)]);
  const count = h.writes.length;
  h.layer.update({ records: [record], now: NOTAM_NOW + 1000 });
  assert.equal(h.writes.length, count, 'unchanged timing/geometry does not resubmit');
});

test('replacement coalesces pending data, clears old points, and only reveals accepted current points', async t => {
  const h = setup(t), newer = { ...record, text: record.text.replace('370015N', '370025N') };
  h.layer.update({ records: [newer], now: NOTAM_NOW });
  h.writes[0]!.resolve(); await flush(); assert.equal(h.visibility(), 'none');
  assert.notDeepEqual(h.writes[0]!.data.features[0]!.geometry, h.writes[1]!.data.features[0]!.geometry);
  h.writes[1]!.resolve(); await flush(); assert.equal(h.visibility(), 'visible');
  for (const listener of h.listeners) listener({ sourceId: NOTAM_CHART_SOURCE, error: new Error('decode failed') });
  assert.equal(h.visibility(), 'none');
  assert.deepEqual(h.shown(), [], 'a failed map must restore coordinate prose');
  h.layer.update({ records: [], now: NOTAM_NOW });
  h.writes.at(-1)!.resolve(); await flush(); assert.equal(h.visibility(), 'none');
});

test('unmount removes owned resources and a late acceptance cannot change a replacement attachment', async t => {
  const h = setup(t), old = h.writes[0]!;
  h.layer.unmount();
  assert.deepEqual(h.shown(), []);
  assert.equal(h.layers.size + h.images.size + h.sources.size + h.listeners.size, 0);
  h.layer.mount(h.map);
  old.resolve(); await flush(); assert.equal(h.visibility(), 'none');
  h.writes[1]!.resolve(); await flush(); assert.equal(h.visibility(), 'visible');
  h.layer.unmount(); h.layer.unmount();
  assert.equal(h.layers.size + h.images.size + h.sources.size + h.listeners.size, 0);
});

test('area boundaries and labels share acceptance, stow and failure lifetime', async t => {
  const h = setup(t), area = notice({ text: 'AIRSPACE UAS WI AN AREA DEFINED AS .5NM RADIUS OF 370000N1220000W SFC-400FT AGL' });
  h.layer.update({ records: [area], now: NOTAM_NOW });
  h.writes[0]!.resolve(); await flush();
  assert.deepEqual(h.shown(), []);
  assert.deepEqual(h.writes[1]!.data.features.map(f => f.geometry.type), ['Polygon', 'Point']);
  h.writes[1]!.resolve(); await flush();
  assert.deepEqual(h.shown(), [notamChartKey(area)]);
  h.layer.update({ records: [], now: NOTAM_NOW });
  assert.equal(h.visibility(), 'none'); assert.deepEqual(h.shown(), []);
  h.writes[2]!.reject(new Error('late failure')); await flush();
  assert.deepEqual(h.shown(), []);
});

test('cleanup continues after a failed layer removal and cancels pending retries', async t => {
  const h = setup(t);
  t.mock.method(console, 'error', () => {});
  t.mock.method(h.map, 'removeLayer', () => { throw new Error('style already removed'); });
  h.writes[0]!.reject(new Error('decode failed')); await flush();
  h.layer.unmount();
  assert.equal(h.images.size + h.sources.size + h.listeners.size, 0);
  h.layer.unmount();
});
