import assert from 'node:assert/strict';
import test from 'node:test';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { FeatureCollectionResponse } from '@zlayer/contracts';
import { createMetarLayer, featureWithMetar } from '../src/layers/metar-taf/metar/layer';
import { MetarClient } from '../src/layers/metar-taf/metar/client';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
test('METAR owns its source, visible demand, stationary refresh and attachment cleanup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-09-15T17:00:00Z') });
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const window = new EventTarget();
  const navigator = { onLine: true };
  for (const [name, value] of Object.entries({ document, window, navigator })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, name, original) : Reflect.deleteProperty(globalThis, name));
  }
  const sources = new Map<string, FeatureCollectionResponse>();
  const layers = new Set(['airports-major-points']);
  const listeners = new Map<string, Set<(event?: unknown) => void>>();
  const visibility = new Map<string, string>();
  let queries = 0, moving = false;
  let visible = ['KSFO'];
  const writes: string[] = [];
  const map = {
    addSource(id: string, source: { data: FeatureCollectionResponse }) { sources.set(id, source.data); },
    addLayer(layer: { id: string }) { layers.add(layer.id); },
    getLayer(id: string) { return layers.has(id) ? {} : undefined; },
    getSource(id: string) { return sources.has(id) ? { setData(data: FeatureCollectionResponse) { writes.push(id); sources.set(id, data); } } : undefined; },
    removeLayer(id: string) { layers.delete(id); }, removeSource(id: string) { sources.delete(id); },
    setLayoutProperty(id: string, _property: string, value: string) { visibility.set(id, value); },
    getLayoutProperty: (id: string) => visibility.get(id), isMoving: () => moving,
    queryRenderedFeatures: () => { queries++; return visible.map(icaoId => ({ properties: { icaoId } })); },
    on(type: string, callback: (event?: unknown) => void) { const callbacks = listeners.get(type) ?? new Set(); callbacks.add(callback); listeners.set(type, callbacks); },
    off(type: string, callback: (event?: unknown) => void) { listeners.get(type)?.delete(callback); },
  } as unknown as MapLibreMap;
  const emit = (type: string, event?: unknown) => { for (const callback of listeners.get(type) ?? []) callback(event); };
  const calls: string[][] = [];
  let fail = false;
  const client = new MetarClient(new URL('https://example.test/weather'), {
    fetch: async url => {
      const ids = new URL(String(url)).searchParams.get('ids')!.split(',');
      calls.push(ids);
      if (fail) return new Response(null, { status: 400 });
      return Response.json({ type: 'FeatureCollection', features: ids.map(id => ({
        type: 'Feature', geometry: { type: 'Point', coordinates: [-122, 37] },
        properties: { id, obsTime: new Date().toISOString(), fltcat: 'VFR' },
      })) });
    },
  });
  const product = createMetarLayer(client);
  const airports: FeatureCollectionResponse = { type: 'FeatureCollection',
    meta: { revision: 'test', layer: 'airports', returned: 2, truncated: false },
    features: ['KSFO', 'KJFK'].map(icaoId => ({ type: 'Feature',
      geometry: { type: 'Point', coordinates: [-122, 37] }, properties: { icaoId, kind: icaoId === 'KSFO' ? 'landing-facility' : 'airport' } })),
  };
  sources.set('nav-airports', airports);
  product.map.update({ airports, enabled: true, airportsVisible: true });
  product.map.mount(map);
  assert.deepEqual(writes, [], 'mount uploads the initial data only once');
  const initialQueries = queries;
  for (let i = 0; i < 120; i++) emit('render');
  assert.equal(queries, initialQueries, 'unrelated stationary renders do not query airport features');
  emit('sourcedata', { sourceId: 'route-plan' }); emit('render');
  assert.equal(queries, initialQueries, 'unrelated source updates do not invalidate weather scope');
  emit('sourcedata', { sourceId: 'nav-airports' }); emit('render');
  assert.equal(queries, initialQueries + 1, 'late airport tiles are queried after rendering');
  emit('sourcedata', { sourceId: 'metar-airports' }); emit('render');
  assert.equal(queries, initialQueries + 2, 'late weather circles also affect station coverage');
  emit('resize'); emit('styledata'); emit('render');
  assert.equal(queries, initialQueries + 3, 'resize and style changes coalesce into one query');
  const advance = async (ms: number) => { t.mock.timers.tick(ms); await flush(); };
  await advance(250);
  assert.deepEqual(calls, [['KSFO']]);
  assert.equal(product.getSnapshot().state.status, 'current');
  assert.equal(sources.get('metar-airports')!.features.length, 1);
  assert.equal(sources.get('nav-airports'), airports);
  const before = featureWithMetar(airports.features[0]!, product.getSnapshot()).properties.metarObservedAt;
  await advance(60_000);
  assert.equal(calls.length, 2);
  assert.notEqual(featureWithMetar(airports.features[0]!, product.getSnapshot()).properties.metarObservedAt, before);
  assert.ok(writes.every(id => id === 'metar-airports'), 'refresh does not rebuild navigation');
  moving = true; emit('movestart'); visible = ['KJFK'];
  const beforeMove = queries;
  emit('sourcedata', { sourceId: 'nav-airports' }); emit('render');
  assert.equal(queries, beforeMove, 'movement never starts requests for intermediate views');
  assert.deepEqual(product.getSnapshot().visibleStationIds, []);
  moving = false; emit('moveend'); emit('render');
  await advance(250);
  assert.deepEqual(calls.at(-1), ['KJFK']);
  assert.ok(product.getSnapshot().stations.has('KSFO'));
  product.map.update({ airports, enabled: false, airportsVisible: true });
  emit('render');
  const disabledQueries = queries;
  for (let i = 0; i < 120; i++) emit('render');
  assert.equal(queries, disabledQueries, 'disabled weather does not query on unrelated renders');
  await advance(120_000);
  assert.equal(calls.length, 3);
  product.map.update({ airports, enabled: true, airportsVisible: true });
  document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
  await advance(120_000);
  assert.equal(calls.length, 3);
  document.visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange'));
  await advance(250);
  assert.equal(calls.length, 4);
  navigator.onLine = false; window.dispatchEvent(new Event('offline'));
  await advance(120_000);
  assert.equal(calls.length, 4);
  product.map.unmount();
  assert.equal(sources.has('metar-airports'), false);
  assert.ok([...listeners.values()].every(callbacks => callbacks.size === 0));
  navigator.onLine = true; window.dispatchEvent(new Event('online'));
  await advance(120_000);
  assert.equal(calls.length, 4, 'unmounted layer cannot resume work');
  product.map.mount(map);
  await advance(250);
  assert.equal(calls.length, 5);
  assert.ok(product.getSnapshot().stations.has('KSFO'), 'remount retains off-screen cache');
  writes.length = 0;
  fail = true;
  await client.refresh(['KSFO'], new AbortController().signal);
  assert.ok(product.getSnapshot().stations.get('KSFO')?.error);
  assert.deepEqual(writes, [], 'a refresh error changes status but does not rebuild unchanged observations');
  product.map.update({ airports, enabled: true, airportsVisible: false }); emit('render');
  assert.deepEqual(writes, [], 'hiding airports changes visibility without resubmitting geometry');
  assert.deepEqual(product.getSnapshot().visibleStationIds, []);
  assert.equal(visibility.get('airports-weather-points'), 'none');
  product.map.update({ airports, enabled: true, airportsVisible: true }); emit('render');
  assert.deepEqual(writes, []);
  assert.deepEqual(product.getSnapshot().visibleStationIds, ['KJFK']);
  const refreshedAirports = { ...airports, features: airports.features.map(feature => ({ ...feature,
    geometry: { type: 'Point' as const, coordinates: [-120, 35] as [number, number] } })) };
  product.map.update({ airports: refreshedAirports, enabled: true, airportsVisible: true });
  assert.deepEqual(writes, ['metar-airports'], 'new navigation geometry invalidates the join');
  assert.deepEqual(sources.get('metar-airports')!.features[0]!.geometry.coordinates, [-120, 35]);
  product.map.unmount();
});
