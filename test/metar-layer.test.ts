import assert from 'node:assert/strict';
import test from 'node:test';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { FeatureCollectionResponse, MetarFeature } from '@zlayer/contracts';
import { createMetarLayer, featureWithMetar } from '../src/layers/metar-taf/metar/layer';
import { MetarClient } from '../src/layers/metar-taf/metar/client';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
test('pending empty and category-disabled replacements stay hidden through repeated environment callbacks', async t => {
  let cleanup = () => {};
  // Release map listeners while the document/window fixtures still exist.
  t.after(() => cleanup());
  const now = Date.parse('2026-09-15T17:00:00Z');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  for (const [name, value] of Object.entries({ document: Object.assign(new EventTarget(), { visibilityState: 'visible' }),
    window: new EventTarget(), navigator: { onLine: false } })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, name, original) : Reflect.deleteProperty(globalThis, name));
  }
  const report: MetarFeature = { type: 'Feature', geometry: { type: 'Point', coordinates: [-122, 37] },
    properties: { id: 'KSFO', obsTime: now / 1000, fltcat: 'IFR', rawOb: 'METAR KSFO TEST' } };
  const client = new MetarClient(new URL('https://example.test/weather'), {
    storage: { getItem: () => JSON.stringify({ type: 'FeatureCollection', features: [report] }), setItem() {} },
  });
  const airports: FeatureCollectionResponse = { type: 'FeatureCollection',
    meta: { revision: 'test', layer: 'airports', returned: 1, truncated: false },
    features: [{ ...report, properties: { kind: 'airport', icaoId: 'KSFO' } }] };
  const layers = new Set<string>(), visibility = new Map<string, unknown>();
  const uploads: { data: FeatureCollectionResponse; accept: () => void }[] = [];
  const map = {
    addSource() {}, removeSource() {}, addLayer: ({ id }: { id: string }) => layers.add(id),
    getLayer: (id: string) => layers.has(id), removeLayer: (id: string) => layers.delete(id),
    getSource: () => ({ setData: (data: FeatureCollectionResponse) => new Promise<void>(accept => uploads.push({ data, accept })) }),
    getLayoutProperty: (id: string) => visibility.get(id),
    setLayoutProperty: (id: string, _key: string, value: unknown) => visibility.set(id, value),
    isMoving: () => false, queryRenderedFeatures: () => [], on() {}, off() {},
  } as unknown as MapLibreMap;
  const product = createMetarLayer(client);
  product.map.update({ airports, enabled: true, airportsVisible: true }); product.map.mount(map);
  cleanup = () => product.map.unmount();
  const visible = () => visibility.get('airports-weather-points');
  product.map.update({ airports: undefined, enabled: true, airportsVisible: true });
  document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('offline'));
  assert.equal(visible(), 'none'); assert.equal(uploads.length, 1);
  uploads[0]!.accept(); await flush();
  document.dispatchEvent(new Event('visibilitychange')); assert.equal(visible(), 'none');
  product.map.update({ airports, enabled: true, airportsVisible: true });
  uploads[1]!.accept(); await flush(); assert.equal(visible(), 'visible');
  product.map.update({ airports, enabled: false, airportsVisible: true });
  document.dispatchEvent(new Event('visibilitychange')); assert.equal(visible(), 'none');
  assert.equal(uploads[2]!.data.features[0]!.properties.displayFlightCategory, 'N/A');
  uploads[2]!.accept(); await flush(); assert.equal(visible(), 'visible', 'accepted gray points remain useful');
  product.map.update({ airports: undefined, enabled: false, airportsVisible: true });
  product.map.update({ airports, enabled: true, airportsVisible: true });
  uploads[3]!.accept(); await flush(); assert.equal(visible(), 'none', 'obsolete clear completion cannot release suppression');
  product.map.unmount(); uploads[4]!.accept(); await flush(); assert.equal(layers.size, 0);
});

test('METAR map colors expire offline while local reports remain available', async t => {
  const now = Date.parse('2026-09-15T17:00:00Z');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const window = new EventTarget();
  const navigator = { onLine: false };
  for (const [name, value] of Object.entries({ document, window, navigator })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, name, original) : Reflect.deleteProperty(globalThis, name));
  }
  const report = (id: string, age: number): MetarFeature => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [-122, 37] },
    properties: { id, obsTime: (now - age) / 1000, fltcat: 'IFR', rawOb: `METAR ${id} TEST` },
  });
  const reports = [report('KSQL', 5 * 3600_000), report('KPAO', 0), report('KOLD', 2 * 3600_000),
    report('KFUT', -3 * 3600_000), report('KUNK', 0), report('KNIL', 0)];
  delete reports[4]!.properties.obsTime;
  reports[5]!.properties.rawOb = 'METAR KNIL NIL';
  const saved = JSON.stringify({ type: 'FeatureCollection', features: reports });
  const client = new MetarClient(new URL('https://example.test/weather'), {
    storage: { getItem: () => saved, setItem() {} },
    fetch: async () => Response.json({ type: 'FeatureCollection', features: [{ ...reports[0]!,
      properties: { ...reports[0]!.properties, obsTime: Date.now() / 1000 } }] }),
  });
  const airports: FeatureCollectionResponse = { type: 'FeatureCollection',
    meta: { revision: 'test', layer: 'airports', returned: reports.length, truncated: false },
    features: reports.map(({ geometry, properties }) => ({ type: 'Feature', geometry,
      properties: { kind: 'airport', icaoId: properties.id! } })),
  };
  let data: FeatureCollectionResponse | undefined, writes = 0;
  const layers = new Set<string>();
  const map = {
    addSource(_id: string, source: { data: FeatureCollectionResponse }) { data = source.data; },
    addLayer(layer: { id: string }) { layers.add(layer.id); },
    getLayer: (id: string) => layers.has(id) ? {} : undefined,
    getSource: () => ({ setData(value: FeatureCollectionResponse) { data = value; writes++; } }),
    removeLayer(id: string) { layers.delete(id); }, removeSource() { data = undefined; },
    setLayoutProperty() {}, getLayoutProperty: () => 'visible',
    isMoving: () => false, queryRenderedFeatures: () => [], on() {}, off() {},
  } as unknown as MapLibreMap;
  const product = createMetarLayer(client);
  const properties = (id: string) => data!.features.find(feature => feature.properties.icaoId === id)!.properties;
  product.map.update({ airports, enabled: true, airportsVisible: true });
  product.map.mount(map);
  assert.equal(properties('KSQL').displayFlightCategory, 'N/A', 'a five-hour-old IFR report renders gray');
  assert.equal(properties('KSQL').flightCategory, 'IFR', 'the original category is preserved');
  assert.equal(properties('KSQL').rawMetar, 'METAR KSQL TEST');
  assert.equal(properties('KPAO').displayFlightCategory, 'IFR', 'a nearby current report does not recolor KSQL');
  assert.equal(properties('KOLD').displayFlightCategory, 'IFR', 'exactly two hours is still current');
  for (const id of ['KFUT', 'KUNK', 'KNIL']) assert.equal(properties(id).displayFlightCategory, 'N/A');
  const snapshot = client.snapshot();
  t.mock.timers.tick(30_000);
  assert.equal(properties('KOLD').displayFlightCategory, 'N/A', 'a stationary offline map ages to gray');
  assert.equal(writes, 1);
  assert.equal(client.snapshot(), snapshot, 'display aging does not modify cached observations');
  assert.equal(featureWithMetar(airports.features[0]!, snapshot).properties.flightCategory, 'IFR');
  t.mock.timers.tick(30_000);
  assert.equal(writes, 1, 'unchanged freshness does not resubmit geometry');
  document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
  t.mock.timers.tick(3 * 3600_000);
  assert.equal(writes, 1, 'hidden documents pause the display clock');
  document.visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(properties('KPAO').displayFlightCategory, 'N/A', 'returning reconciles expired observations');
  assert.equal(properties('KFUT').displayFlightCategory, 'IFR', 'a future timestamp becomes current when its time arrives');
  navigator.onLine = true; window.dispatchEvent(new Event('online'));
  await client.refresh(['KSQL'], new AbortController().signal);
  assert.equal(properties('KSQL').displayFlightCategory, 'IFR', 'a fresh local report restores its category color');
  product.map.update({ airports, enabled: true, airportsVisible: false });
  const hiddenWrites = writes;
  t.mock.timers.tick(3 * 3600_000);
  assert.equal(writes, hiddenWrites, 'hidden Airports pause the display clock');
  product.map.update({ airports, enabled: true, airportsVisible: true });
  assert.equal(properties('KSQL').displayFlightCategory, 'N/A');
  product.map.unmount();
  const detachedWrites = writes;
  t.mock.timers.tick(30_000);
  assert.equal(writes, detachedWrites, 'unmount cancels the display clock');
});

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
  const emit = (type: string, event?: unknown) => { for (const callback of listeners.get(type) ?? []) callback(event ?? {}); };
  const calls: string[][] = [];
  let fail = false, hold = false;
  let heldSignal: AbortSignal | undefined;
  let releaseHeld: (() => void) | undefined;
  const client = new MetarClient(new URL('https://example.test/weather'), {
    fetch: async (url, options) => {
      const ids = new URL(String(url)).searchParams.get('ids')!.split(',');
      calls.push(ids);
      if (hold) {
        const signal = heldSignal = options!.signal!;
        await new Promise<void>((resolve, reject) => {
          releaseHeld = resolve;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
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
  const settled = product.getSnapshot();
  emit('styledata'); emit('sourcedata', { sourceId: 'nav-airports' }); emit('render');
  assert.equal(product.getSnapshot(), settled, 'unchanged station scope does not republish weather state');
  const movingSnapshots: number[] = [];
  const stopObserving = product.subscribe(() => movingSnapshots.push(product.getSnapshot().weatherAirportCount));
  for (let i = 0; i < 3; i++) {
    moving = true; emit('movestart'); emit('render');
    assert.equal(product.getSnapshot().weatherAirportCount, settled.weatherAirportCount);
    assert.equal(product.getSnapshot().state.observedAt, settled.state.observedAt);
    await advance(1_000);
    assert.equal(calls.length, 2, 'GPS movement pauses acquisition');
    moving = false; emit('moveend'); emit('render');
  }
  assert.ok(movingSnapshots.every(count => count === settled.weatherAirportCount), 'no transient empty legend during follow animations');
  stopObserving();
  // Resume an unchanged scope after its cached station check becomes due.
  moving = true; emit('movestart');
  await advance(60_000);
  assert.equal(calls.length, 2, 'stationary refresh remains paused throughout movement');
  moving = false; emit('moveend'); emit('render');
  await advance(250);
  assert.equal(calls.length, 3, 'unchanged stations resume after movement');
  moving = true; emit('movestart'); visible = ['KJFK'];
  const beforeMove = queries;
  emit('sourcedata', { sourceId: 'nav-airports' }); emit('render');
  assert.equal(queries, beforeMove, 'movement never starts requests for intermediate views');
  assert.deepEqual(product.getSnapshot().visibleStationIds, ['KSFO'], 'presentation retains the last settled scope');
  moving = false; emit('moveend'); emit('render');
  await advance(250);
  assert.deepEqual(calls.at(-1), ['KJFK']);
  assert.ok(product.getSnapshot().stations.has('KSFO'));
  moving = true; emit('movestart'); visible = [];
  assert.equal(product.getSnapshot().weatherAirportCount, 1);
  moving = false; emit('moveend'); emit('render');
  assert.deepEqual(product.getSnapshot().visibleStationIds, []);
  assert.equal(product.getSnapshot().weatherAirportCount, 0, 'settling over an empty view clears the legend');
  visible = ['KJFK']; emit('moveend'); emit('render');
  product.map.update({ airports, enabled: false, airportsVisible: true });
  emit('render');
  const disabledQueries = queries;
  for (let i = 0; i < 120; i++) emit('render');
  assert.equal(queries, disabledQueries, 'disabled weather does not query on unrelated renders');
  await advance(120_000);
  assert.equal(calls.length, 4);
  product.map.update({ airports, enabled: true, airportsVisible: true });
  document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
  await advance(120_000);
  assert.equal(calls.length, 4);
  document.visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange'));
  await advance(250);
  assert.equal(calls.length, 5);
  navigator.onLine = false; window.dispatchEvent(new Event('offline'));
  await advance(120_000);
  assert.equal(calls.length, 5);
  product.map.unmount();
  assert.equal(sources.has('metar-airports'), false);
  assert.ok([...listeners.values()].every(callbacks => callbacks.size === 0));
  navigator.onLine = true; window.dispatchEvent(new Event('online'));
  await advance(120_000);
  assert.equal(calls.length, 5, 'unmounted layer cannot resume work');
  product.map.mount(map);
  assert.equal(sources.get('metar-airports')!.features.length, 0, 'detached airport data is released independently of the weather cache');
  product.map.unmount();
  product.map.update({ airports, enabled: true, airportsVisible: true });
  product.map.mount(map);
  await advance(250);
  assert.equal(calls.length, 6);
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
  fail = false;
  await advance(60_000);
  await client.refresh(['KSFO'], new AbortController().signal);
  assert.deepEqual(writes, [], 'card refreshes do not rebuild the hidden map source');
  product.map.update({ airports, enabled: true, airportsVisible: true }); emit('render');
  assert.deepEqual(writes, ['metar-airports'], 'showing Airports submits the latest cached reports once');
  writes.length = 0;
  assert.deepEqual(product.getSnapshot().visibleStationIds, ['KJFK']);
  const refreshedAirports = { ...airports, features: airports.features.map(feature => ({ ...feature,
    geometry: { type: 'Point' as const, coordinates: [-120, 35] as [number, number] } })) };
  product.map.update({ airports: refreshedAirports, enabled: true, airportsVisible: true });
  assert.deepEqual(writes, ['metar-airports'], 'new navigation geometry invalidates the join');
  assert.deepEqual(sources.get('metar-airports')!.features[0]!.geometry.coordinates, [-120, 35]);
  fail = false; hold = true;
  await advance(60_000);
  assert.ok(heldSignal && !heldSignal.aborted, 'a stationary refresh is in flight');
  const followingCalls = calls.length;
  for (let i = 0; i < 10; i++) {
    moving = true; emit('movestart', { gpsCamera: true });
    await advance(250);
    moving = false; emit('moveend'); emit('render');
    await advance(750);
    assert.equal(heldSignal.aborted, false, 'GPS follow preserves a slow request for the settled scope');
  }
  assert.equal(calls.length, followingCalls, 'follow does not restart the request');
  hold = false; releaseHeld!(); await flush();
  assert.equal(product.getSnapshot().state.status, 'current', 'the slow response is accepted after repeated follow animations');
  hold = true; await advance(60_000);
  assert.ok(heldSignal && !heldSignal.aborted);
  const beforeCancellation = product.getSnapshot();
  moving = true; emit('movestart');
  assert.ok(heldSignal.aborted, 'movement cancels the in-flight request');
  await flush();
  assert.equal(product.getSnapshot().weatherAirportCount, beforeCancellation.weatherAirportCount);
  assert.equal(product.getSnapshot().state.observedAt, beforeCancellation.state.observedAt);
  product.map.update({ airports: refreshedAirports, enabled: true, airportsVisible: false });
  assert.equal(product.getSnapshot().weatherAirportCount, 0, 'hiding Airports during movement clears the legend immediately');
  product.map.update({ airports: refreshedAirports, enabled: true, airportsVisible: true });
  navigator.onLine = false; window.dispatchEvent(new Event('offline'));
  navigator.onLine = true; window.dispatchEvent(new Event('online'));
  document.dispatchEvent(new Event('visibilitychange'));
  const pausedCalls = calls.length;
  await advance(60_000);
  assert.equal(calls.length, pausedCalls, 'input and environment changes cannot resume requests while moving');
  hold = false;
  moving = false; emit('moveend'); emit('render');
  await advance(250);
  assert.equal(calls.length, pausedCalls + 1, 'cancelled acquisition resumes after settling');
  assert.equal(product.getSnapshot().weatherAirportCount, 1);
  assert.equal(product.getSnapshot().state.status, 'current');
  product.map.unmount();
});
