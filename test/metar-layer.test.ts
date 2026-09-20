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
  const listeners = new Map<string, Set<() => void>>();
  let visible = ['KSFO'];
  const writes: string[] = [];
  const map = {
    addSource(id: string, source: { data: FeatureCollectionResponse }) { sources.set(id, source.data); },
    addLayer(layer: { id: string }) { layers.add(layer.id); },
    getLayer(id: string) { return layers.has(id) ? {} : undefined; },
    getSource(id: string) { return sources.has(id) ? { setData(data: FeatureCollectionResponse) { writes.push(id); sources.set(id, data); } } : undefined; },
    removeLayer(id: string) { layers.delete(id); }, removeSource(id: string) { sources.delete(id); },
    setLayoutProperty() {}, isMoving: () => false,
    queryRenderedFeatures: () => visible.map(icaoId => ({ properties: { icaoId } })),
    on(type: string, callback: () => void) { const callbacks = listeners.get(type) ?? new Set(); callbacks.add(callback); listeners.set(type, callbacks); },
    off(type: string, callback: () => void) { listeners.get(type)?.delete(callback); },
  } as unknown as MapLibreMap;
  const emit = (type: string) => { for (const callback of listeners.get(type) ?? []) callback(); };
  const calls: string[][] = [];
  const client = new MetarClient(new URL('https://example.test/weather'), {
    fetch: async url => {
      const ids = new URL(String(url)).searchParams.get('ids')!.split(',');
      calls.push(ids);
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
  emit('movestart'); visible = ['KJFK']; emit('render');
  await advance(250);
  assert.deepEqual(calls.at(-1), ['KJFK']);
  assert.ok(product.getSnapshot().stations.has('KSFO'));
  product.map.update({ airports, enabled: false, airportsVisible: true });
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
  product.map.unmount();
});
