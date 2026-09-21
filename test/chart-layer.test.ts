import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { LayerSpecification, Map as MapLibreMap } from 'maplibre-gl';
import type { Bounds, CatalogResponse, ChartPackageArchive, ChartRecord } from '@zlayer/contracts';
import { CHART_LAYER_ANCHOR } from '../src/core/map/layer';
import { CHART_FAMILIES, type ChartSelection } from '../src/layers/charts/overlays';
import { createWorkspaceReadContext, type CatalogReadSource } from '../src/workspace/read-context';
import type { SavedBundle } from '../src/offline/bundle-repository';
import { notifyOfflineInventory } from '../src/offline/inventory-events';

const registered: CatalogReadSource[] = [];
const failures = new Set<(chartId: string) => void>();
Object.assign(globalThis, { chartRegistrations: registered, chartFailures: failures });
const restoreGlobals: Array<() => void> = [];
test.beforeEach(() => {
  for (const [name, value] of Object.entries({ window: new EventTarget(), BroadcastChannel: undefined })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    restoreGlobals.push(() => { if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name); });
  }
  failures.clear();
});
test.afterEach(() => { for (const restore of restoreGlobals.splice(0)) restore(); });
const loader = registerHooks({ resolve(specifier, context, next) {
  if (specifier === './mbtiles-protocol' && context.parentURL?.includes('/charts/')) return {
    shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`
      export const registerMbtilesArchives = catalog => globalThis.chartRegistrations.push(catalog);
      export const mbtilesTileUrl = id => 'mbtiles://' + id;
      export const observeChartFailures = listener => {
        globalThis.chartFailures.add(listener);
        return () => globalThis.chartFailures.delete(listener);
      };
    `),
  };
  return next(specifier, context);
} });
const { createChartLayer } = await import('../src/layers/charts/layer');
loader.deregister();

const chart: ChartRecord = { id: 'sectional', title: 'Sectional', kind: 'vfr-sectional', revision: '2026-09-03',
  format: 'mbtiles', bounds: [-120, 30, -110, 40], minZoom: 5, maxZoom: 12,
  url: 'https://charts.test/a.mbtiles', sha256: 'a'.repeat(64), byteLength: 1024 };
const catalog: CatalogResponse = { schemaVersion: 1, revision: chart.revision, generatedAt: '2026-09-16T00:00:00Z',
  charts: [chart], navigation: [], weather: [] };
const sectionalOnly: ChartSelection = { base: 'vfr-sectional', overlay: '' };

for (const event of ['inventory', 'online']) test(`${event} rebuilds only failed chart families and unmount releases recovery listeners`, () => {
  const { map, added, layers } = mapFixture();
  const current = { ...catalog, charts: [chart, { ...chart, id: 'terminal', kind: 'vfr-terminal' as const }] };
  const selection: ChartSelection = { base: 'vfr-sectional', overlay: 'vfr-terminal' };
  const products = CHART_FAMILIES.map(family => createChartLayer(current, family));
  products.forEach(product => { product.update({ catalog: current, selection }); product.mount(map); });
  const retry = () => event === 'inventory' ? notifyOfflineInventory() : window.dispatchEvent(new Event('online'));
  const order = [...layers];
  retry();
  assert.equal(added(), 2, 'healthy sources are preserved');
  for (const chartId of ['@vfr-terminal', 'terminal']) {
    const before = added();
    for (const listener of failures) listener(chartId);
    retry();
    assert.equal(added(), before + 1, 'only the failed family is reinstalled');
    assert.deepEqual(layers, order, 'repair preserves chart and navigation stacking');
    retry();
    assert.equal(added(), before + 1, 'a retry clears the failure until a new read fails');
  }
  products.forEach(product => product.unmount());
  assert.equal(failures.size, 0);
  const before = added();
  retry();
  assert.equal(added(), before, 'detached maps never reinstall resources');
});

function mapFixture() {
  const layers = [CHART_LAYER_ANCHOR, 'navigation'];
  const sources = new Set(['navigation']);
  const visibility = new Map<string, unknown>();
  const listeners = new Map<string, Set<() => void>>();
  let bounds: Bounds = [-180, -85, 180, 85];
  let added = 0;
  const map = {
    on(type: string, listener: () => void) { const callbacks = listeners.get(type) ?? new Set(); callbacks.add(listener); listeners.set(type, callbacks); },
    off(type: string, listener: () => void) { listeners.get(type)?.delete(listener); },
    getBounds: () => ({ getWest: () => bounds[0], getEast: () => bounds[2], getSouth: () => bounds[1], getNorth: () => bounds[3] }),
    getLayer: (id: string) => layers.includes(id),
    getSource: (id: string) => sources.has(id),
    addSource(id: string) { assert.ok(!sources.has(id)); sources.add(id); added++; },
    removeSource(id: string) { sources.delete(id); },
    addLayer(layer: LayerSpecification, before: string) {
      layers.splice(layers.indexOf(before), 0, layer.id);
      visibility.set(layer.id, layer.layout?.visibility);
    },
    removeLayer(id: string) { layers.splice(layers.indexOf(id), 1); visibility.delete(id); },
    getLayoutProperty: (id: string) => visibility.get(id),
    setLayoutProperty: (id: string, _key: string, value: string) => visibility.set(id, value),
  } as unknown as MapLibreMap;
  return { map, layers, sources, added: () => added,
    move(next: Bounds) { bounds = next; for (const callback of listeners.get('move') ?? []) callback(); },
    listenerCount: () => [...listeners.values()].reduce((sum, callbacks) => sum + callbacks.size, 0),
    visible: () => layers.filter(id => visibility.get(id) === 'visible'),
  };
}

for (const packaged of [false, true]) {
  test(`${packaged ? 'packaged' : 'sheet'} charts reuse compiled families while viewport visibility and catalog replacement remain live`, () => {
    const { map, move, visible, listenerCount } = mapFixture();
    let reads = 0;
    const records = [chart, { ...chart, id: 'terminal', kind: 'vfr-terminal' as const, bounds: [-118, 33, -117, 34] as Bounds }];
    const current: CatalogResponse = { ...catalog,
      get charts() { reads++; return records; },
      ...(packaged ? { chartPackages: { root: '/charts', maximumArchiveBytes: 1024, archives: [], regions: [] } } : {}),
    };
    const selection: ChartSelection = { base: 'vfr-sectional', overlay: 'vfr-terminal' };
    const products = CHART_FAMILIES.map(family => createChartLayer(current, family));
    products.forEach(product => { product.update({ catalog: current, selection }); product.mount(map); });
    assert.equal(listenerCount(), 4);
    reads = 0;
    for (let i = 0; i < 60; i++) move([-119, 32, -118.5, 35]);
    assert.equal(reads, 0, 'movement does not traverse catalog records again');
    assert.deepEqual(visible(), packaged ? ['chart-@vfr-sectional', 'chart-@vfr-terminal'] : ['chart-sectional']);
    move([242.2, 33.2, 242.8, 33.8]);
    assert.deepEqual(visible(), packaged ? ['chart-@vfr-sectional', 'chart-@vfr-terminal'] : ['chart-sectional', 'chart-terminal'],
      'wrapped viewports still activate the matching sheets');
    const refreshed = { ...current, charts: [{ ...chart, id: 'new-sheet', bounds: [10, 10, 20, 20] as Bounds }] };
    products.forEach(product => product.update({ catalog: refreshed, selection }));
    assert.deepEqual(visible(), packaged ? ['chart-@vfr-sectional'] : [], 'new catalog definitions replace the old cache');
    move([12, 12, 18, 18]);
    assert.deepEqual(visible(), [packaged ? 'chart-@vfr-sectional' : 'chart-new-sheet']);
    products.forEach(product => product.unmount());
    assert.equal(listenerCount(), 0);
  });
}

test('refreshing chart definitions replaces only owned resources below navigation', () => {
  const { map, layers, sources, added } = mapFixture();
  const product = createChartLayer(catalog, CHART_FAMILIES.find(family => family.id === chart.kind)!);
  product.update({ catalog, selection: sectionalOnly });
  product.mount(map);
  assert.deepEqual(layers, ['chart-sectional', CHART_LAYER_ANCHOR, 'navigation']);
  product.update({ catalog, selection: sectionalOnly });
  assert.equal(added(), 1, 'selection updates do not reinstall sources');
  const refreshed = { ...catalog, charts: [{ ...chart, id: 'expanded', sha256: 'b'.repeat(64) }] };
  product.update({ catalog: refreshed, selection: sectionalOnly });
  assert.deepEqual(layers, ['chart-expanded', CHART_LAYER_ANCHOR, 'navigation']);
  assert.deepEqual(sources, new Set(['navigation', 'chart-expanded']));
  assert.equal(registered.at(-1), refreshed);
  product.unmount();
  assert.deepEqual(layers, [CHART_LAYER_ANCHOR, 'navigation']);
  assert.deepEqual(sources, new Set(['navigation']));
});

test('metadata and saved-region health updates preserve existing chart sources', () => {
  const { map, added, visible } = mapFixture();
  const saved: SavedBundle = { catalog, bounds: [chart.bounds], key: 'saved',
    plan: { id: 'region', regionId: 'region', title: 'Region', revision: catalog.revision, files: [], references: [] } };
  const context = createWorkspaceReadContext(catalog, [saved]);
  const product = createChartLayer(context, CHART_FAMILIES[0]!);
  product.update({ catalog: context, selection: sectionalOnly });
  product.mount(map);
  const healthUpdate = createWorkspaceReadContext(structuredClone(catalog), [{ ...saved, unavailable: false }]);
  product.update({ catalog: healthUpdate, selection: { ...sectionalOnly } });
  assert.equal(added(), 1, 'finishing the saved-file check must not discard chart tiles');
  const metadata = { ...structuredClone(catalog), generatedAt: '2026-09-19T00:00:00Z',
    charts: [{ ...chart, title: 'Updated title' }],
    navigation: [{ id: 'airports' as const, title: 'Airports', count: 1, sourceCount: 1, minZoom: 0, url: '/updated-airports.json' }] };
  const refreshed = createWorkspaceReadContext(metadata, [{ ...saved, key: 'new-navigation-snapshot', catalog: metadata }]);
  product.update({ catalog: refreshed, selection: { ...sectionalOnly } });
  assert.equal(added(), 1, 'navigation metadata must not invalidate chart resources');
  assert.equal(registered.at(-1), refreshed, 'future tile requests use the current catalog');
  assert.deepEqual(visible(), ['chart-@vfr-sectional']);
  product.unmount();
  product.mount(map);
  assert.equal(added(), 2, 'remount still installs the current resources');
  assert.deepEqual(visible(), ['chart-@vfr-sectional']);
  product.unmount();
});

test('a chart family refresh leaves other families and their tiles intact', () => {
  const { map, added, visible } = mapFixture();
  const current = { ...catalog, charts: [chart, { ...chart, id: 'terminal', kind: 'vfr-terminal' as const }] };
  const selection: ChartSelection = { base: 'vfr-sectional', overlay: 'vfr-terminal' };
  const products = CHART_FAMILIES.map(family => createChartLayer(current, family));
  products.forEach(product => { product.update({ catalog: current, selection }); product.mount(map); });
  const refreshed = { ...current, charts: current.charts.map(chart => chart.id === 'terminal'
    ? { ...chart, url: '/new-terminal.mbtiles', sha256: 'b'.repeat(64) } : chart) };
  products.forEach(product => product.update({ catalog: refreshed, selection }));
  assert.equal(added(), 3, 'only the terminal source should be replaced');
  assert.deepEqual(visible(), ['chart-sectional', 'chart-terminal']);
  products.forEach(product => product.unmount());
});

test('chart archive and regional ownership changes still replace cached tile sources', () => {
  const archive: ChartPackageArchive = { id: 'vfr-sectional-z5-r2-0-0', kind: 'vfr-sectional',
    file: 'sectional.mbtiles', zoom: 5, root: { z: 2, x: 0, y: 0 }, bounds: chart.bounds,
    tileMask: '1', sha256: chart.sha256, byteLength: 1024 };
  const packaged: CatalogResponse = { ...catalog, chartPackages: {
    root: '/packages', maximumArchiveBytes: 2048, archives: [archive], regions: [],
  } };
  const saved: SavedBundle = { catalog: packaged, bounds: [chart.bounds], key: 'saved',
    plan: { id: 'region', regionId: 'region', title: 'Region', revision: catalog.revision, files: [], references: [] } };
  const other: SavedBundle = { ...saved, catalog: { ...packaged, charts: [{ ...chart, revision: '2026-08-06' }] },
    key: 'other', plan: { ...saved.plan, id: 'other', regionId: 'other' } };
  const context = createWorkspaceReadContext(packaged, [saved, other]);
  const changedArchive = (change: Partial<ChartPackageArchive>): CatalogResponse => ({ ...packaged,
    chartPackages: { ...packaged.chartPackages!, archives: [{ ...archive, ...change }] } });
  const cases: Array<[string, CatalogReadSource]> = [
    ['archive content', createWorkspaceReadContext(changedArchive({ sha256: 'b'.repeat(64) }), [saved, other])],
    ['archive address', createWorkspaceReadContext(changedArchive({ file: 'replacement.mbtiles' }), [saved, other])],
    ['archive size', createWorkspaceReadContext(changedArchive({ byteLength: 2048 }), [saved, other])],
    ['tile coverage', createWorkspaceReadContext(changedArchive({ tileMask: '3' }), [saved, other])],
    ['package root', createWorkspaceReadContext({ ...packaged,
      chartPackages: { ...packaged.chartPackages!, root: '/new-packages' } }, [saved, other])],
    ['saved chart content', createWorkspaceReadContext(packaged, [{ ...saved,
      catalog: changedArchive({ sha256: 'c'.repeat(64) }) }, other])],
    ['regional bounds', createWorkspaceReadContext(packaged, [{ ...saved, bounds: [[-125, 30, -110, 40]] }, other])],
    ['state boundary', createWorkspaceReadContext(packaged, [{ ...saved, plan: { ...saved.plan, regionId: 'us-CA' } }, other])],
    ['overlap priority', createWorkspaceReadContext(packaged, [other, saved])],
    ['removed region', createWorkspaceReadContext(packaged, [other])],
    ['chart resolution', createWorkspaceReadContext({ ...packaged, charts: [{ ...chart, maxZoom: 13 }] }, [saved, other])],
  ];
  for (const [reason, next] of cases) {
    const { map, added, visible } = mapFixture();
    const product = createChartLayer(context, CHART_FAMILIES[0]!);
    product.update({ catalog: context, selection: sectionalOnly });
    product.mount(map);
    product.update({ catalog: next, selection: sectionalOnly });
    assert.equal(added(), 2, reason);
    assert.equal(registered.at(-1), next, reason);
    assert.deepEqual(visible(), ['chart-@vfr-sectional']);
    product.unmount();
  }
});

for (const packaged of [false, true]) {
  test(`${packaged ? 'packaged' : 'sheet'} chart stacks preserve overlay order, exclusivity, and inactive sources`, () => {
    const { map, layers, visible, added } = mapFixture();
    const current: CatalogResponse = { ...catalog,
      charts: CHART_FAMILIES.map(family => ({ ...chart, id: family.id, kind: family.id })),
      ...(packaged ? { chartPackages: { root: '/charts', maximumArchiveBytes: 1024, archives: [], regions: [] } } : {}),
    };
    const id = (family: string) => `chart-${packaged ? '@' : ''}${family}`;
    let selection: ChartSelection = { base: 'vfr-sectional', overlay: 'vfr-terminal' };
    const products = CHART_FAMILIES.map(definition => createChartLayer(current, definition));
    for (const product of [...products].reverse()) {
      product.update({ catalog: current, selection });
      product.mount(map);
    }
    const order = [...CHART_FAMILIES.map(family => id(family.id)), CHART_LAYER_ANCHOR, 'navigation'];
    assert.deepEqual(layers, order, 'stack order must not depend on mount order');
    assert.deepEqual(visible(), [id('vfr-sectional'), id('vfr-terminal')]);
    const refresh = { ...current, charts: current.charts.map(chart => ({ ...chart, sha256: 'b'.repeat(64) })) };
    products[0]!.update({ catalog: refresh, selection });
    assert.deepEqual(layers, order, 'a refreshed sectional must not cover an existing overlay');
    const additions = added();
    selection = { base: 'vfr-sectional', overlay: 'vfr-flyway' };
    products.forEach(product => product.update({ catalog: product === products[0] ? refresh : current, selection }));
    assert.deepEqual(visible(), [id('vfr-sectional'), id('vfr-flyway')]);
    selection = { base: 'ifr-low', overlay: 'vfr-flyway' };
    products.forEach(product => product.update({ catalog: product === products[0] ? refresh : current, selection }));
    assert.deepEqual(visible(), [id('ifr-low')], 'inactive VFR overlays must not request tiles over IFR');
    selection = { base: '', overlay: 'vfr-flyway' };
    products.forEach(product => product.update({ catalog: product === products[0] ? refresh : current, selection }));
    assert.deepEqual(visible(), []);
    assert.equal(added(), additions, 'selection changes reuse sources and their whole-file caches');
    products.forEach(product => product.unmount());
    assert.deepEqual(layers, [CHART_LAYER_ANCHOR, 'navigation']);
  });
}
