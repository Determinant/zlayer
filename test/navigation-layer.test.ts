import assert from 'node:assert/strict';
import test from 'node:test';
import type { Map as MapLibreMap, LayerSpecification } from 'maplibre-gl';
import type { FeatureCollectionResponse, GeoPointFeature } from '@zlayer/contracts';
import { featureFilter } from '@maplibre/maplibre-gl-style-spec';
import { createNavigationLayer } from '../src/layers/navigation/layer';
import { DEFAULT_VISIBILITY, NAVIGATION_LAYERS } from '../src/layers/navigation/definitions';
import { DEFAULT_FIX_DISPLAY } from '../src/layers/navigation/fix-display';
import { PRIORITY_FIX_LAYER_ID, PRIORITY_FIX_SOURCE_ID } from '../src/layers/navigation/renderer';
import { installMetarLayers } from '../src/layers/metar-taf/metar/renderer';
import { createRouteLayer } from '../src/layers/routes/layer';
import { CHART_LAYER_ANCHOR, ROUTE_LINE_ANCHOR, MapLayerHost } from '../src/core/map/layer';

function mapFixture(t: test.TestContext) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const context = new Proxy({}, { get: (_target, name) => name === 'getImageData'
    ? (_x: number, _y: number, width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) })
    : () => {} });
  Object.defineProperty(globalThis, 'document', { configurable: true,
    value: { createElement: () => ({ getContext: () => context }) } });
  t.after(() => original ? Object.defineProperty(globalThis, 'document', original) : Reflect.deleteProperty(globalThis, 'document'));
  const sources = new Map<string, FeatureCollectionResponse>();
  const layers = new Map<string, LayerSpecification>();
  const order: string[] = [];
  const images = new Set<string>();
  const visibility = new Map<string, string>();
  const writes: string[] = [];
  const map = {
    addSource(id: string, source: { data: FeatureCollectionResponse }) { sources.set(id, source.data); },
    getSource(id: string) { return sources.has(id) ? { setData(data: FeatureCollectionResponse) { sources.set(id, data); writes.push(id); } } : undefined; },
    removeSource(id: string) { sources.delete(id); },
    addLayer(layer: LayerSpecification, beforeId?: string) {
      const index = beforeId ? order.indexOf(beforeId) : order.length;
      assert.ok(index >= 0, `Missing layer anchor: ${beforeId}`);
      order.splice(index, 0, layer.id);
      layers.set(layer.id, layer);
    },
    getLayer(id: string) { return layers.get(id); },
    moveLayer(id: string, beforeId?: string) {
      assert.ok(layers.has(id), `Missing layer: ${id}`);
      order.splice(order.indexOf(id), 1);
      order.splice(beforeId ? order.indexOf(beforeId) : order.length, 0, id);
    },
    removeLayer(id: string) { order.splice(order.indexOf(id), 1); layers.delete(id); },
    addImage(id: string) { assert.ok(!images.has(id)); images.add(id); }, hasImage: (id: string) => images.has(id),
    removeImage(id: string) { images.delete(id); },
    setLayoutProperty(id: string, _key: string, value: string) { visibility.set(id, value); },
    setGlobalStateProperty() {},
    on() {}, off() {},
  } as unknown as MapLibreMap;
  return { map, sources, layers, images, visibility, writes, order };
}

test('equivalent fix inputs skip source replacement while priority edits retain order and refreshed records', t => {
  const { map, sources, writes } = mapFixture(t);
  const features: GeoPointFeature[] = ['FIRST', 'SECOND'].map(ident => ({ type: 'Feature', id: `fix:${ident}`,
    geometry: { type: 'Point', coordinates: [-122, 37] }, properties: { kind: 'fix', ident, charts: ['ENROUTE LOW'] } }));
  const fixes: FeatureCollectionResponse = { type: 'FeatureCollection', features,
    meta: { layer: 'fixes', revision: 'test', returned: features.length, truncated: false } };
  const product = createNavigationLayer();
  const input = { data: { fixes }, visibility: DEFAULT_VISIBILITY, fixDisplay: DEFAULT_FIX_DISPLAY, priorityFixes: [] as GeoPointFeature[] };
  product.update(input); product.mount(map); writes.length = 0;
  const background = sources.get('nav-fixes');
  product.update({ ...input, fixDisplay: { ...DEFAULT_FIX_DISPLAY }, priorityFixes: [] });
  assert.deepEqual(writes, [], 'equivalent empty arrays and settings are a no-op');
  assert.equal(sources.get('nav-fixes'), background);
  product.update({ ...input, priorityFixes: features });
  assert.deepEqual(writes, ['nav-fixes', PRIORITY_FIX_SOURCE_ID]);
  writes.length = 0;
  product.update({ ...input, priorityFixes: [...features, features[0]!] });
  assert.deepEqual(writes, [], 'duplicate priority occurrences have no rendering effect');
  product.update({ ...input, priorityFixes: [...features].reverse() });
  assert.deepEqual(writes, [PRIORITY_FIX_SOURCE_ID], 'reordering priority icons does not change background density');
  assert.deepEqual(sources.get(PRIORITY_FIX_SOURCE_ID)!.features.map(f => f.id), [...features].reverse().map(f => f.id));
  writes.length = 0;
  const refreshed = { ...features[0]!, geometry: { type: 'Point' as const, coordinates: [-121, 38] as [number, number] } };
  product.update({ ...input, priorityFixes: [features[1]!, refreshed] });
  assert.deepEqual(writes, [PRIORITY_FIX_SOURCE_ID], 'same identity with refreshed coordinates still updates the priority source');
  assert.deepEqual(sources.get(PRIORITY_FIX_SOURCE_ID)!.features[1]!.geometry.coordinates, [-121, 38]);
  writes.length = 0;
  product.update({ ...input, priorityFixes: [] });
  assert.deepEqual(writes, ['nav-fixes', PRIORITY_FIX_SOURCE_ID]);
  assert.deepEqual(sources.get('nav-fixes'), background, 'clearing priorities restores the original rendering');
  product.unmount();
});

test('route lines stay below markers and waypoint labels stay above circles across remounts and chart refreshes', t => {
  const { map, order, layers } = mapFixture(t);
  for (const id of [CHART_LAYER_ANCHOR, ROUTE_LINE_ANCHOR]) {
    map.addLayer({ id, type: 'background', paint: { 'background-opacity': 0 } });
  }
  const navigation = createNavigationLayer();
  const route = createRouteLayer();
  const host = new MapLayerHost(map, (_id, error) => { throw error; });
  const markers = [...NAVIGATION_LAYERS.flatMap(layer => layer.layerIds), PRIORITY_FIX_LAYER_ID,
    'route-waypoint-halos', 'route-waypoints', 'route-waypoint-labels', 'route-insert-preview'];
  for (let attempt = 0; attempt < 2; attempt++) {
    host.mount([route, navigation]);
    // Chart replacement uses its own anchor and must not cover route lines.
    map.addLayer({ id: 'refreshed-chart', type: 'background' }, CHART_LAYER_ANCHOR);
    const lines = [...layers.values()].filter(layer => layer.type === 'line' && layer.id !== 'route-leg-hits');
    assert.equal(lines.length, 16, 'route, alternative and drag lines, including procedure/approach/missed styling and halos');
    for (const line of lines) {
      assert.ok(order.indexOf('refreshed-chart') < order.indexOf(line.id));
      for (const marker of markers) {
        assert.ok(order.indexOf(line.id) < order.indexOf(marker), `${marker} must be above ${line.id}`);
      }
    }
    const circles = [...layers.values()].filter(layer => layer.type === 'circle');
    for (const label of [PRIORITY_FIX_LAYER_ID, 'route-waypoint-labels']) {
      for (const circle of circles) {
        assert.ok(order.indexOf(circle.id) < order.indexOf(label), `${label} must be above ${circle.id}`);
      }
    }
    assert.ok(order.indexOf('route-hold-direction') > order.indexOf('route-waypoint-labels'),
      'hold arrows retain their collision priority when the host raises route labels');
    map.removeLayer('refreshed-chart');
  }
  host.unmount();
  assert.deepEqual(order, [CHART_LAYER_ANCHOR, ROUTE_LINE_ANCHOR]);
});

test('map-only filtering updates independently, honors context with the layer off, and survives remount', t => {
  const { map, sources, layers, images, visibility, writes } = mapFixture(t);
  const enroute: GeoPointFeature = { type: 'Feature', id: 'fix:ENRTE', geometry: { type: 'Point', coordinates: [-122, 37] },
    properties: { kind: 'fix', ident: 'ENRTE', charts: ['ENROUTE LOW'] } };
  const approach: GeoPointFeature = { ...enroute, id: 'fix:APPRO', properties: { kind: 'fix', ident: 'APPRO', charts: ['IAP'] } };
  const fixes: FeatureCollectionResponse = { type: 'FeatureCollection', features: [enroute, approach],
    meta: { layer: 'fixes', revision: 'test', returned: 2, truncated: false } };
  const data = { fixes };
  const product = createNavigationLayer();
  const background = () => sources.get('nav-fixes')!.features.map(f => f.id);
  const priority = () => sources.get(PRIORITY_FIX_SOURCE_ID)!.features.map(f => f.id);
  product.update({ data, visibility: DEFAULT_VISIBILITY });
  product.mount(map);
  assert.deepEqual(background(), [enroute.id]);
  assert.equal(visibility.get('fixes-icons'), 'visible');
  assert.ok(product.interactiveLayerIds?.includes(PRIORITY_FIX_LAYER_ID));
  writes.length = 0;
  product.update({ data, visibility: DEFAULT_VISIBILITY, fixDisplay: { detail: 'all', airspace: 'both' } });
  assert.deepEqual(background(), [enroute.id, approach.id]);
  assert.deepEqual(writes, ['nav-fixes'], 'a detail setting must not reload airport/weather sources');
  product.update({ data, visibility: DEFAULT_VISIBILITY, fixDisplay: DEFAULT_FIX_DISPLAY, priorityFixes: [approach, enroute, approach] });
  assert.deepEqual(priority(), [approach.id, enroute.id]);
  assert.deepEqual(background(), []);
  assert.notEqual(visibility.get(PRIORITY_FIX_LAYER_ID), 'none', 'context bypasses the background toggle');
  product.unmount();
  assert.equal(sources.size + layers.size + images.size, 0);
  product.mount(map);
  assert.deepEqual(priority(), [approach.id, enroute.id]);
  product.update({ data, visibility: { ...DEFAULT_VISIBILITY, fixes: true }, priorityFixes: [] });
  assert.deepEqual(priority(), []);
  assert.deepEqual(background(), [enroute.id]);
  assert.equal(visibility.get('fixes-icons'), 'visible');
  assert.deepEqual(data.fixes.features, [enroute, approach]);
  product.unmount();
});

test('navigation loading updates only changed sources and clears removed data', t => {
  const { map, writes, sources } = mapFixture(t);
  const collection = (layer: FeatureCollectionResponse['meta']['layer']): FeatureCollectionResponse => ({
    type: 'FeatureCollection', meta: { layer, revision: 'test', returned: 1, truncated: false },
    features: [{ type: 'Feature', id: layer, geometry: { type: 'Point', coordinates: [-122, 37] },
      properties: { kind: layer === 'fixes' ? 'fix' : 'airport', ident: 'TEST', charts: ['ENROUTE LOW'] } }],
  });
  const airports = collection('airports'), fixes = collection('fixes'), navaids = collection('navaids');
  const product = createNavigationLayer();
  product.update({ data: { airports, fixes }, visibility: DEFAULT_VISIBILITY });
  product.mount(map);
  writes.length = 0;
  product.update({ data: { airports, fixes }, visibility: DEFAULT_VISIBILITY });
  assert.deepEqual(writes, [], 'a new wrapper for unchanged data must not retile navigation');
  product.update({ data: { airports, fixes, navaids }, visibility: DEFAULT_VISIBILITY });
  assert.deepEqual(writes, ['nav-navaids'], 'late data must not redraw already loaded layers');
  writes.length = 0;
  product.update({ data: { airports, navaids }, visibility: DEFAULT_VISIBILITY });
  assert.deepEqual(writes, ['nav-fixes']);
  assert.equal(sources.get('nav-fixes')!.features.length, 0, 'removed fixes must not remain on the map');
  writes.length = 0;
  const updated = collection('airports');
  product.update({ data: { airports: updated, navaids }, visibility: DEFAULT_VISIBILITY });
  assert.deepEqual(writes, ['nav-airports']);
  product.unmount();
  product.mount(map);
  assert.equal(sources.get('nav-airports')!.features.length, 1);
  assert.equal(sources.get('nav-navaids')!.features.length, 1);
  assert.equal(sources.get('nav-fixes')!.features.length, 0);
  product.unmount();
});

test('background IFR fixes share the airport-circle cutoff without exposing VP or terminal fixes early', t => {
  const { map, sources, layers } = mapFixture(t);
  const fixes: FeatureCollectionResponse = { type: 'FeatureCollection', meta: { layer: 'fixes', revision: 'test', returned: 5, truncated: false },
    features: [['JOIN', 'ENROUTE LOW'], ['AIRWY', 'ENROUTE LOW'], ['OFFRT', 'ENROUTE LOW'], ['TERM', 'STAR'], ['APPRO', 'IAP']]
      .map(([ident, chart], index) => ({ type: 'Feature', id: ident!, geometry: { type: 'Point', coordinates: [-122 + index * 20, 37] },
        properties: { kind: 'fix', ident: ident!, charts: [chart!] } })),
  };
  const product = createNavigationLayer();
  product.update({ data: { fixes }, visibility: { ...DEFAULT_VISIBILITY, fixes: true },
    fixDisplay: { detail: 'all', airspace: 'both' }, airways: {
      type: 'ZLayerAirways', metadata: { effectiveDate: 'test', source: 'fixture' },
      airways: [['V1', 'JOIN', 'AIRWY'], ['T2', 'JOIN']].map(([ident, ...points]) => ({
        id: ident!, ident: ident!, points, segments: points.map((from, sequence) => ({ from, sequence, gap: false, fromType: 'RP' })),
      })),
    },
  });
  product.mount(map);
  const layer = layers.get('fixes-icons')!;
  assert.equal(layer.type, 'symbol');
  assert.equal(layer.minzoom, 6.5);
  assert.equal(layer.minzoom, layers.get('airports-major-points')!.minzoom);
  assert.equal(layer.minzoom, layers.get('airports-major-halo')!.minzoom);
  installMetarLayers(map, { ...fixes, features: [] });
  assert.equal(layer.minzoom, layers.get('airports-weather-points')!.minzoom);
  assert.equal(layer.minzoom, layers.get('airports-weather-halo')!.minzoom);
  assert.ok(layers.get('airports-weather-labels')!.minzoom! >= layer.minzoom!);
  if (layer.type !== 'symbol') throw new Error('Fixes must use collision placement');
  const filter = featureFilter(layer.filter, 'fixes.filter').filter;
  const visible = (zoom: number) => sources.get('nav-fixes')!.features.filter(feature =>
    zoom >= layer.minzoom! && filter({ zoom: Math.floor(zoom) }, { type: 'Point', properties: feature.properties })).map(feature => feature.id);
  for (const [zoom, expected] of [
    [3, []], [5, []], [6.49, []],
    [6.5, ['JOIN', 'AIRWY', 'OFFRT']], [6.99, ['JOIN', 'AIRWY', 'OFFRT']],
    [7, ['JOIN', 'AIRWY', 'OFFRT']],
    [9, ['JOIN', 'AIRWY', 'OFFRT']],
    [11, ['JOIN', 'AIRWY', 'OFFRT', 'TERM']], [12, ['JOIN', 'AIRWY', 'OFFRT', 'TERM', 'APPRO']],
  ] as const) assert.deepEqual(visible(zoom), expected, `zoom ${zoom}`);
  assert.equal(layers.get('vfr-waypoints-icons')!.minzoom, 10);
  assert.equal(layers.get(PRIORITY_FIX_LAYER_ID)!.minzoom, 3, 'selected and route fixes remain visible below the background cutoff');
  assert.notEqual(layer.layout?.['icon-allow-overlap'], true);
  assert.notEqual(layer.layout?.['text-allow-overlap'], true);
  assert.equal(layer.layout?.['text-optional'], false, 'background icons and labels declutter together');
  assert.deepEqual(layer.layout?.['symbol-sort-key'], ['get', 'mapFixPriority']);
  product.unmount();
});
