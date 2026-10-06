import assert from 'node:assert/strict';
import test from 'node:test';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { TFR_DETAIL_REFRESH_MS, type TfrSnapshot, type TfrNotice } from '@zlayer/contracts';
import { createTfrMapLayer, TFR_FILL, TFR_SOURCE, TFR_HIGHLIGHT } from '../src/layers/notams/tfr-map';
import { createTfrClient, type TfrState } from '../src/layers/notams/tfr-client';
import { bindMapLayer } from '../src/core/map/contribution';

const NOW = Date.parse('2026-10-05T21:00Z');
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function snapshot(): TfrSnapshot {
  return { schemaVersion: 1, source: 'FAA-TFR', checkedAt: NOW, notices: [0, 1, 2].map(i => ({
    id: `6/900${i}`, modifiedAt: NOW, detailCheckedAt: NOW - TFR_DETAIL_REFRESH_MS + (i + 1) * 1000,
    title: 'Synthetic TFR', type: 'HAZARDS', facility: 'TST', state: 'CA', text: 'Test only',
    startsAt: i === 2 ? NOW + 60_000 : NOW - 60_000, endsAt: NOW + 120_000,
    areas: [{ id: '1', name: 'Area A', lower: 'SFC', upper: '3000 ft MSL',
      geometry: { type: 'Polygon', coordinates: [[[-122, 37], [-121, 37], [-121, 38], [-122, 37]]] },
      windows: [{ startsAt: i === 2 ? NOW + 60_000 : NOW - 60_000, endsAt: NOW + 120_000 }] }],
  })) };
}
function setup(t: test.TestContext) {
  const layers = new Set<string>(), sources = new Set<string>();
  const listeners = new Set<(e: unknown) => void>();
  const writes: { data: FeatureCollection; resolve(): void; reject(error: unknown): void }[] = [];
  const styles: { id: string; color: string }[] = [], visibility: string[] = [];
  const filters = new Map<string, unknown>();
  const source = { setData: (data: FeatureCollection) => new Promise<void>((resolve, reject) => writes.push({ data, resolve, reject })) };
  const map = {
    addSource(id: string) { sources.add(id); }, getSource: (id: string) => sources.has(id) ? source : undefined,
    addLayer(layer: { id: string }) { layers.add(layer.id); }, getLayer: (id: string) => layers.has(id),
    setLayoutProperty(id: string, _key: string, value: string) { if (id === TFR_FILL) visibility.push(value); },
    setFeatureState({ id }: { id: string }, { color }: { color: string }) { styles.push({ id, color }); },
    setFilter(id: string, filter: unknown) { filters.set(id, filter); },
    removeFeatureState() {},
    removeSource: (id: string) => sources.delete(id), removeLayer: (id: string) => layers.delete(id),
    on(_type: string, listener: (e: unknown) => void) { listeners.add(listener); },
    off(_type: string, listener: (e: unknown) => void) { listeners.delete(listener); },
    queryRenderedFeatures: () => writes.at(-1)!.data.features,
  } as unknown as MapLibreMap;
  let shown: readonly TfrNotice[] = [];
  const layer = createTfrMapLayer(notices => { shown = notices; });
  const state: TfrState = { snapshot: snapshot(), now: NOW, loading: false };
  layer.update(state); layer.mount(map);
  t.after(() => layer.unmount());
  return { layer, map, state, writes, styles, visibility, layers, sources, listeners, filters, shown: () => shown };
}

test('TFR hover follows accepted geometry without worker submissions and clears on failure or removal', async t => {
  const h = setup(t), highlighted = h.state.snapshot!.notices[0]!.id;
  h.layer.update({ ...h.state, highlighted });
  assert.deepEqual(h.filters.get(TFR_HIGHLIGHT), ['==', ['get', 'noticeId'], '']);
  h.writes[0]!.resolve(); await flush();
  assert.deepEqual(h.filters.get(TFR_HIGHLIGHT), ['==', ['get', 'noticeId'], highlighted]);
  h.layer.update(h.state);
  assert.deepEqual(h.filters.get(TFR_HIGHLIGHT), ['==', ['get', 'noticeId'], '']);
  h.layer.update({ ...h.state, highlighted });
  assert.equal(h.writes.length, 1, 'hover/focus only changes filters on the existing source');
  assert.equal(h.styles.length, 3, 'hover preserves active/upcoming colors');
  for (const listener of h.listeners) listener({ sourceId: TFR_SOURCE, error: new Error('worker failed') });
  assert.deepEqual(h.filters.get(TFR_HIGHLIGHT), ['==', ['get', 'noticeId'], '']);
  assert.deepEqual(h.shown(), []);
  h.layer.update({ ...h.state, snapshot: { ...h.state.snapshot!, notices: [] } });
  h.writes.at(-1)!.resolve(); await flush();
  assert.deepEqual(h.filters.get(TFR_HIGHLIGHT), ['==', ['get', 'noticeId'], '']);
  h.layer.unmount();
  assert.equal(h.layers.size, 0);
});

test('TFR detail expiry and refresh preserve colors and geometry until the schedule changes', async t => {
  const h = setup(t);
  h.writes[0]!.resolve(); await flush();
  assert.equal(h.styles.length, 3); assert.deepEqual(h.visibility, ['visible']);
  assert.deepEqual(h.layer.inspectAt({ x: 0, y: 0 }), h.state.snapshot!.notices.map(n => ({ noticeId: n.id, areaId: '1' })));
  for (let seconds = 1; seconds <= 30; seconds++) h.layer.update({ ...h.state, now: NOW + seconds * 1000 });
  h.layer.update({ ...h.state, now: NOW + 30_000, loading: true, error: 'Refresh failed' });
  assert.equal(h.writes.length, 1, 'no worker/GeoJSON work for freshness changes or age-label ticks');
  assert.deepEqual(h.styles.slice(3), [], 'detail age and refresh failure cannot recolor areas');
  assert.deepEqual(h.visibility, ['visible'], 'no hide/show blink as each detail expires');

  const refreshed = structuredClone(h.state.snapshot!);
  refreshed.checkedAt = NOW + 30_000;
  refreshed.notices.forEach(n => { n.detailCheckedAt = NOW + 30_000; });
  h.layer.update({ snapshot: refreshed, now: NOW + 30_000, loading: false });
  assert.equal(h.writes.length, 1, 'newly parsed, unchanged coordinates reuse the accepted source');
  assert.equal(h.styles.length, 3, 'refreshing unchanged schedules cannot recolor areas');
  h.layer.update({ snapshot: refreshed, now: NOW + 60_000, loading: false });
  assert.equal(h.writes.length, 1, 'activation recolors in place');
  assert.deepEqual(h.styles.at(-1), { id: '6/9002:1', color: '#ff4d55' });
  assert.deepEqual(h.visibility, ['visible']);
});

test('TFR geometry revisions and expiry still replace the source and wait for acceptance before inspection', async t => {
  const h = setup(t);
  assert.deepEqual(h.shown(), []);
  h.writes[0]!.resolve(); await flush();
  assert.equal(h.shown().length, 3);
  const revised = structuredClone(h.state.snapshot!);
  revised.notices[0]!.areas[0]!.geometry!.coordinates[0]![1]![0] = -120;
  h.layer.update({ ...h.state, snapshot: revised });
  assert.equal(h.writes.length, 2, 'coordinates can change even without a new modification timestamp');
  assert.deepEqual(h.layer.inspectAt({ x: 0, y: 0 }), []);
  assert.deepEqual(h.shown(), [], 'readers cannot abbreviate a pending revision');
  h.writes[1]!.resolve(); await flush();
  assert.equal(h.layer.inspectAt({ x: 0, y: 0 }).length, 3);
  assert.equal(h.shown()[0], revised.notices[0]);
  h.layer.update({ ...h.state, snapshot: revised, now: NOW + 120_000 });
  assert.equal(h.writes.length, 3); assert.equal(h.writes[2]!.data.features.length, 0);
  assert.deepEqual(h.layer.inspectAt({ x: 0, y: 0 }), [], 'expired geometry cannot remain inspectable while the worker runs');
  h.writes[2]!.resolve(); await flush();
  assert.equal(h.visibility.at(-1), 'none');
  assert.deepEqual(h.shown(), []);
});

test('TFR reader receipts exclude incomplete or failed details and restore full text on teardown', async t => {
  const h = setup(t);
  h.writes[0]!.resolve(); await flush();
  const revised = structuredClone(h.state.snapshot!);
  revised.notices[0]!.areas.push({ ...revised.notices[0]!.areas[0]!, id: 'missing', geometry: null });
  revised.issues = [{ id: revised.notices[1]!.id, title: 'Synthetic TFR', type: 'HAZARDS', facility: 'TST', state: 'CA', modifiedAt: NOW,
    reason: 'detail-invalid', retainedCheckedAt: NOW }];
  h.layer.update({ ...h.state, snapshot: revised });
  assert.equal(h.writes.length, 1, 'same geometry does not need a new worker submission');
  assert.deepEqual(h.shown().map(n => n.id), ['6/9002']);
  h.layer.unmount(); assert.deepEqual(h.shown(), []);
});

test('pending TFR submissions use the latest colors; clock rollback and map reattachment restore them', async t => {
  const h = setup(t);
  h.layer.update({ ...h.state, now: NOW + 60_000 });
  assert.equal(h.styles.length, 0);
  h.writes[0]!.resolve(); await flush();
  assert.ok(h.styles.every(s => s.color === '#ff4d55'));
  h.layer.update(h.state);
  assert.deepEqual(h.styles.at(-1), { id: '6/9002:1', color: '#ffd54a' });
  assert.equal(h.writes.length, 1);
  h.layer.unmount(); assert.equal(h.layers.size + h.sources.size + h.listeners.size, 0);
  h.layer.update(h.state); h.layer.mount(h.map);
  h.writes[1]!.resolve(); await flush();
  assert.deepEqual(h.styles.slice(-3).map(s => s.color), ['#ff4d55', '#ff4d55', '#ffd54a']);
  assert.equal(h.visibility.at(-1), 'visible');
});

test('TFR source failure stays hidden through a bounded retry and teardown cancels further work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = setup(t);
  for (const listener of h.listeners) listener({ sourceId: TFR_SOURCE, error: new Error('Worker failure') });
  h.writes[0]!.resolve(); await flush();
  assert.deepEqual(h.layer.inspectAt({ x: 0, y: 0 }), []);
  t.mock.timers.tick(100);
  assert.equal(h.writes.length, 2);
  h.writes[1]!.reject(new Error('Still failed')); await flush();
  t.mock.timers.tick(1000); assert.equal(h.writes.length, 2);
  h.layer.unmount(); t.mock.timers.tick(30_000);
  assert.equal(h.writes.length, 2); assert.equal(h.listeners.size, 0);
});

test('the live client drives staggered detail deadlines without repeated map submissions or network reads', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  const h = setup(t); h.layer.unmount(); h.writes.length = 0;
  let requests = 0;
  const client = createTfrClient({ debounceMs: 0, storage: { read: () => h.state.snapshot!, async update() { return false; } },
    load: async () => { requests++; return h.state.snapshot!; } });
  client.start(); t.after(client.stop);
  const bound = bindMapLayer(h.layer, client.state);
  bound.mount(h.map); t.after(bound.subscribeInputs!(() => bound.update()));
  t.mock.timers.tick(0); await flush(); h.writes[0]!.resolve(); await flush();
  for (let seconds = 1; seconds <= 30; seconds++) t.mock.timers.tick(1000);
  assert.equal(requests, 1); assert.equal(h.writes.length, 1);
  assert.deepEqual(h.visibility, ['visible']);
});
