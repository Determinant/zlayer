import assert from 'node:assert/strict';
import test from 'node:test';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { createNotamChartLayer, NOTAM_CHART_SOURCE, NOTAM_HIGHLIGHT_POINT, NOTAM_HIGHLIGHT_AREA, NOTAM_HIGHLIGHT_RADIAL } from '../src/layers/notams/map';
import { notice, NOTAM_NOW } from './fixtures/notams';
import { notamChartKey, notamChartFeatures, createNotamChartSelector } from '../src/layers/notams/chart';
import { createNotamAreaReferences } from '../src/layers/notams/area-references';
import { isFeatureCollectionResponse } from '@zlayer/contracts';
import navaids from './fixtures/notams-us-artcc/zny-navaids.json';

const record = notice({ text: 'OBST CRANE (ASN UNKNOWN) 370015N1220015W (1NM E TST) 350FT (200FT AGL) FLAGGED' });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('chart selection reuses unchanged timing and rebuilds for boundaries, rollback, records and references', () => {
  const select = createNotamChartSelector(), start = NOTAM_NOW;
  const timed = { ...record, startsAt: start + 1000, endsAt: start + 5000 };
  const first = select([timed], start);
  assert.equal(select([timed], start + 500), first, 'a new wrapper array does not rebuild geometry');
  const active = select([timed], start + 1000);
  assert.notEqual(active, first); assert.deepEqual(active, notamChartFeatures([timed], start + 1000));
  assert.equal(select([timed], start + 2000), active);
  const past = select([timed], start + 5000); assert.equal(past.features.length, 0);
  assert.deepEqual(select([timed], start), first, 'rollback recomputes upcoming geometry');
  const changed = select([{ ...timed, text: timed.text.replace('370015N', '370025N') }], start);
  assert.notDeepEqual(changed, first);
  assert.notEqual(select([timed], start, () => undefined), first, 'reference identity participates');
  const unknown = { ...timed, schedule: 'UNKNOWN' };
  const unknownCollection = select([unknown], start + 1500);
  assert.equal(select([unknown], start + 2000), unknownCollection);
});
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
  const filters = new Map<string, unknown>();
  const writes: { data: FeatureCollection; resolve(): void; reject(error: unknown): void }[] = [];
  let visibility = 'none';
  const source = { setData: (data: FeatureCollection) => new Promise<void>((resolve, reject) => writes.push({ data, resolve, reject })) };
  const map = {
    addSource(id: string) { sources.add(id); }, getSource: (id: string) => sources.has(id) ? source : undefined,
    addLayer(layer: { id: string }) { layers.add(layer.id); }, getLayer: (id: string) => layers.has(id),
    setLayoutProperty(_id: string, _key: string, value: string) { visibility = value; },
    setFilter(id: string, filter: unknown) { filters.set(id, filter); },
    setPaintProperty() {},
    addImage(id: string) { images.add(id); }, hasImage: (id: string) => images.has(id),
    removeImage: (id: string) => images.delete(id), removeSource: (id: string) => sources.delete(id), removeLayer: (id: string) => layers.delete(id),
    on(_type: string, listener: (e: unknown) => void) { listeners.add(listener); },
    off(_type: string, listener: (e: unknown) => void) { listeners.delete(listener); },
  } as unknown as MapLibreMap;
  let shown: readonly string[] = [];
  const layer = createNotamChartLayer(keys => { shown = keys; });
  layer.update({ records: [record], now: NOTAM_NOW }); layer.mount(map);
  t.after(() => layer.unmount());
  return { layer, map, writes, layers, images, sources, listeners, filters, visibility: () => visibility, shown: () => shown };
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

test('shared depiction acknowledges and highlights each source identity and survives filtering either filing', async t => {
  const h = setup(t), duplicate = { ...record, id: '1757600000000002' };
  h.writes[0]!.resolve(); await flush();
  h.layer.update({ records: [record, duplicate], now: NOTAM_NOW });
  assert.equal(h.writes[1]!.data.features.length, 1);
  h.writes[1]!.resolve(); await flush();
  assert.deepEqual(h.shown(), [notamChartKey(record), notamChartKey(duplicate)]);
  h.layer.update({ records: [record, duplicate], now: NOTAM_NOW, highlighted: notamChartKey(duplicate) });
  assert.deepEqual(h.filters.get(NOTAM_HIGHLIGHT_POINT), ['all', ['in', ['get', 'kind'], ['literal', ['obstacle', 'activity', 'radial-label']]], ['in', duplicate.id, ['get', 'noticeIds']]]);
  h.layer.update({ records: [duplicate], now: NOTAM_NOW });
  h.writes[2]!.resolve(); await flush();
  assert.deepEqual(h.shown(), [notamChartKey(duplicate)]);
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

test('late and replaced navigation references replace area geometry before acknowledging the same notice revision', async t => {
  const h = setup(t), area = notice({ text: 'AIRSPACE UAS WI AN AREA DEFINED AS .5NM RADIUS OF TST SFC-400FT AGL' });
  const records = [area], references = () => [-122, 37] as [number, number];
  h.layer.update({ records, now: NOTAM_NOW });
  h.writes[0]!.resolve(); await flush(); h.writes[1]!.resolve(); await flush();
  assert.equal(h.visibility(), 'none'); assert.deepEqual(h.shown(), []);
  h.layer.update({ records, now: NOTAM_NOW, references });
  assert.equal(h.writes[2]!.data.features.length, 2);
  // The navigation edition changes while its first source submission is pending.
  const changed = () => [-121, 38] as [number, number];
  h.layer.update({ records, now: NOTAM_NOW, references: changed });
  h.writes[2]!.resolve(); await flush();
  assert.deepEqual(h.shown(), []);
  assert.deepEqual(h.writes[3]!.data.features[1]!.geometry, { type: 'Point', coordinates: [-121, 38] });
  h.writes[3]!.resolve(); await flush();
  assert.deepEqual(h.shown(), [notamChartKey(area)]);
  h.layer.update({ records, now: NOTAM_NOW });
  assert.equal(h.visibility(), 'none'); assert.deepEqual(h.shown(), []);
  h.writes[4]!.resolve(); await flush(); assert.equal(h.writes[4]!.data.features.length, 0);
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

test('entry highlighting reuses accepted geometry, matches the current revision, and clears on removal', async t => {
  const h = setup(t), records = [record];
  h.writes[0]!.resolve(); await flush();
  h.layer.update({ records, now: NOTAM_NOW });
  h.layer.update({ records, now: NOTAM_NOW, highlighted: notamChartKey(record) });
  assert.equal(h.writes.length, 1, 'highlighting must not submit geometry');
  assert.deepEqual(h.filters.get(NOTAM_HIGHLIGHT_POINT), ['all', ['in', ['get', 'kind'], ['literal', ['obstacle', 'activity', 'radial-label']]], ['in', record.id, ['get', 'noticeIds']]]);
  const stale = { ...record, revision: 'b'.repeat(64) };
  h.layer.update({ records, now: NOTAM_NOW, highlighted: notamChartKey(stale) });
  assert.deepEqual(h.filters.get(NOTAM_HIGHLIGHT_POINT), ['all', ['in', ['get', 'kind'], ['literal', ['obstacle', 'activity', 'radial-label']]], ['in', '', ['get', 'noticeIds']]]);
  h.layer.update({ records, now: NOTAM_NOW, highlighted: notamChartKey(record) });
  h.layer.update({ records: [], now: NOTAM_NOW, highlighted: notamChartKey(record) });
  assert.equal(h.visibility(), 'none');
  assert.deepEqual(h.filters.get(NOTAM_HIGHLIGHT_AREA), ['all', ['==', ['get', 'kind'], 'area'], ['in', '', ['get', 'noticeIds']]]);
});

test('radial highlighting reuses prepared directions and loses its receipt when station data is removed', async t => {
  const h = setup(t), collection: unknown = navaids;
  assert(isFeatureCollectionResponse(collection));
  const references = createNotamAreaReferences({ navaids: collection });
  const radial = notice({ text: 'HTO VOR R-236 UNUSABLE BEYOND 40 NM BELOW 6500' }), records = [radial];
  h.writes[0]!.resolve(); await flush();
  h.layer.update({ records, now: NOTAM_NOW, references });
  assert.deepEqual(h.shown(), []);
  h.writes[1]!.resolve(); await flush();
  assert.deepEqual(h.shown(), [notamChartKey(radial)]);
  h.layer.update({ records, now: NOTAM_NOW, references, highlighted: notamChartKey(radial) });
  assert.equal(h.writes.length, 2, 'hover does not submit direction cues again');
  assert.deepEqual(h.filters.get(NOTAM_HIGHLIGHT_RADIAL), ['all', ['==', ['get', 'kind'], 'radial'], ['in', radial.id, ['get', 'noticeIds']]]);
  h.layer.update({ records, now: NOTAM_NOW, highlighted: notamChartKey(radial) });
  assert.deepEqual(h.shown(), []); assert.equal(h.visibility(), 'none');
  assert.deepEqual(h.writes[2]!.data.features, []);
  h.writes[2]!.resolve(); await flush();
  assert.deepEqual(h.shown(), []);
});
