import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { MessageChannel } from 'node:worker_threads';
import { expose, transferHandlers } from 'comlink';
import nodeEndpoint from 'comlink/dist/umd/node-adapter.js';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { createRouteResolver } from '@zlayer/domain';
import { MapLayerHost, TERRAIN_LAYER_ANCHOR, type LayerSlot } from '../src/core/map/layer';
import { createTerrainLayer } from '../src/layers/terrain/layer';
import { unproject, type Tile } from '../src/layers/terrain/geometry';
import { TERRAIN_CONTOUR_SOURCE, TERRAIN_CORRIDOR_SOURCE, TERRAIN_LABEL_SOURCE, TERRAIN_SOURCE } from '../src/layers/terrain/renderer';
import type { TerrainRequest, TerrainResult, TerrainStatus } from '../src/layers/terrain/types';
import type { CatalogResponse, TerrainSource } from '@zlayer/contracts';
import { createWorkspaceReadContext } from '../src/workspace/read-context';
import type { SavedBundle } from '../src/offline/bundle-repository';

async function settled() { for (let i = 0; i < 10; i++) await setImmediate(); }
const tile = (i: number): Tile => ({ z: 13, x: 4000 + i, y: 4096 });
const resolve = createRouteResolver([{ type: 'FeatureCollection',
  features: ['AAAA', 'BBBB'].map((ident, i) => ({ type: 'Feature', id: ident,
    geometry: { type: 'Point', coordinates: [-10 + i * 20, 0] }, properties: { ident } })),
  meta: { layer: 'airports', revision: 'test', returned: 2, truncated: false } }]);
const route = resolve('AAAA BBBB');
const catalog: CatalogResponse = { schemaVersion: 1, revision: '2026-09-03', generatedAt: '2026-09-03T00:00:00Z',
  charts: [], navigation: [], weather: [] };
const terrain: TerrainSource = { schemaVersion: 1, encoding: 'float32-feet-gzip', minZoom: 1, maxZoom: 13,
  generatedAt: catalog.generatedAt, root: 'https://terrain.test/data',
  shards: [{ zoom: 13, x: 3968, y: 4096, file: `${'a'.repeat(64)}.terrain`, sha256: 'a'.repeat(64), byteLength: 100 }] };
type FixtureResult = Omit<TerrainResult, 'data'> & { data: { testTerrainBitmap: number } };

function fixture(t: test.TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const jobs: { request: TerrainRequest; finish: () => void; fail: () => void }[] = [];
  const closed: number[] = [], canceled: number[] = [], workers: TestWorker[] = [], statuses: TerrainStatus[] = [];
  transferHandlers.set('test-terrain-bitmap', {
    canHandle: (value): value is FixtureResult => !!value && typeof value === 'object' && 'data' in value &&
      !!value.data && typeof value.data === 'object' && 'testTerrainBitmap' in value.data,
    serialize: (value: FixtureResult) => [value, []],
    deserialize: (value: FixtureResult) => ({ ...value, data: { close() { closed.push(value.data.testTerrainBitmap); } } }),
  });
  t.after(() => transferHandlers.delete('test-terrain-bitmap'));
  class TestWorker extends EventTarget {
    readonly channel = new MessageChannel();
    terminated = false;
    constructor() {
      super(); workers.push(this);
      this.channel.port1.on('message', data => this.dispatchEvent(new MessageEvent('message', { data })));
      expose({ render: (request: TerrainRequest) => new Promise<TerrainResult>((resolve, reject) => {
        const { x, y, z } = request.tile;
        const coordinate = unproject([(x + 0.5) / 2 ** z, (y + 0.5) / 2 ** z]);
        jobs.push({ request, finish: () => resolve({
          data: { testTerrainBitmap: request.id } as unknown as ImageBitmap,
          labels: [{ coordinate, elevation: x, opacity: 1, peak: true }],
          lines: [{ coordinates: [[coordinate, [coordinate[0] + 0.001, coordinate[1]]]], elevation: x, opacity: 1 }],
        }), fail: () => reject(new Error('Terrain unavailable')) });
      }), cancel: (id: number) => { canceled.push(id); } }, nodeEndpoint(this.channel.port2));
    }
    postMessage(message: unknown, transfer: ArrayBuffer[]) { this.channel.port1.postMessage(message, transfer); }
    terminate() { this.terminated = true; this.channel.port1.close(); this.channel.port2.close(); }
  }
  let cleanup = () => {};
  t.after(() => cleanup());
  for (const [name, value] of Object.entries({ Worker: TestWorker, window: new EventTarget(),
    location: new URL('https://terrain.test/'), requestAnimationFrame: (): number => 1, cancelAnimationFrame: (): void => {} })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : Reflect.deleteProperty(globalThis, name));
  }
  const sources = new Map<string, unknown>(), layers = [TERRAIN_LAYER_ANCHOR], writes: string[] = [];
  const listeners = new Map<string, Set<() => void>>();
  let covered = [tile(0)], loaded = true, zoom = 13, repaints = 0;
  const map = {
    getZoom: () => zoom, coveringTiles: () => covered.map(canonical => ({ canonical })),
    isSourceLoaded: () => loaded, triggerRepaint() { repaints++; },
    on(event: string, handler: () => void) { const set = listeners.get(event) ?? new Set(); set.add(handler); listeners.set(event, set); },
    off: (event: string, handler: () => void) => listeners.get(event)?.delete(handler),
    addSource: (id: string, source: { data?: unknown }) => sources.set(id, source.data),
    getSource: (id: string) => sources.has(id) ? { setData(data: unknown) { sources.set(id, data); writes.push(id); } } : undefined,
    removeSource: (id: string) => sources.delete(id), getLayer: (id: string) => layers.includes(id),
    addLayer(value: { id: string }, before?: string) { layers.splice(before ? layers.indexOf(before) : layers.length, 0, value.id); },
    removeLayer(id: string) { layers.splice(layers.indexOf(id), 1); },
    moveLayer(id: string, before?: string) { layers.splice(layers.indexOf(id), 1); layers.splice(before ? layers.indexOf(before) : layers.length, 0, id); },
    setLayoutProperty() {}, setPaintProperty() {},
  } as unknown as MapLibreMap;
  const layer = createTerrainLayer(status => statuses.push(status));
  layer.update({ enabled: true, routes: [route] }); layer.mount(map);
  const fire = (event: string, data?: unknown) => listeners.get(event)?.forEach(handler =>
    (handler as (data?: unknown) => void)(data));
  const advance = async () => { t.mock.timers.tick(100); await settled(); };
  const finish = async (i: number) => { jobs[i]!.finish(); await settled(); await advance(); };
  cleanup = () => { layer.unmount(); workers.forEach(worker => worker.terminate()); };
  return { layer, map, jobs, workers, statuses, closed, canceled, sources, listeners, writes, layers, fire, advance, finish,
    data: (id = TERRAIN_CONTOUR_SOURCE) => sources.get(id) as { features: { properties: { elevation: number } }[] },
    status: () => statuses.at(-1)!, repaints: () => repaints, loaded(value: boolean) { loaded = value; },
    move(tiles: Tile[]) { covered = tiles; fire('move'); },
    zoom(value: number) { zoom = value; fire('move'); },
    async render() { fire('render'); await settled(); },
  };
}

test('warm terrain pans publish cached vectors before moveend and unchanged coverage does not rewrite sources', async t => {
  const f = fixture(t); await f.render(); await f.finish(0);
  f.move([tile(1)]); await f.render(); await f.finish(1);
  f.writes.length = 0; f.move([tile(0)]);
  assert.equal(f.data().features[0]!.properties.elevation, 4000);
  assert.equal(f.data(TERRAIN_LABEL_SOURCE).features.length, 1);
  assert.equal(f.writes.length, 2);
  f.writes.length = 0;
  for (let i = 0; i < 20; i++) { f.move([tile(0)]); await f.render(); }
  f.zoom(13.2); await f.render();
  assert.equal(f.writes.length, 0); assert.equal(f.jobs.length, 2);
  assert.deepEqual(f.closed, f.jobs.map(job => job.request.id), 'every recovery bitmap is closed');
});

test('catalog metadata updates preserve warm terrain and pending work when elevation sources are unchanged', async t => {
  const f = fixture(t); await f.render(); await f.finish(0);
  const contours = f.data(), labels = f.data(TERRAIN_LABEL_SOURCE);
  f.layer.update({ enabled: true, routes: [route], catalog });
  assert.equal(f.data(), contours, 'adopting a catalog with the same PNG fallback preserves geometry');
  assert.equal(f.data(TERRAIN_LABEL_SOURCE), labels);
  assert.equal(f.status().state, 'ready');
  await f.render(); assert.equal(f.jobs.length, 1);

  f.layer.update({ enabled: true, routes: [route], catalog: { ...catalog, terrain } });
  await f.render(); assert.equal(f.jobs.length, 2);
  f.layer.update({ enabled: true, routes: [route], catalog: { ...catalog,
    generatedAt: '2026-09-20T00:00:00Z', terrain: structuredClone(terrain) } });
  assert.equal(f.canceled.length, 0, 'metadata refresh must not cancel an in-flight tile');
  await f.finish(1);
  const packagedContours = f.data(); f.writes.length = 0;
  f.layer.update({ enabled: true, routes: [route], catalog: { ...catalog, revision: '2026-10-01', terrain } });
  await f.render();
  assert.equal(f.data(), packagedContours); assert.equal(f.writes.length, 0);
  assert.equal(f.jobs.length, 2); assert.equal(f.status().state, 'ready');
});

test('changing terrain content or root cancels the old generation and replaces its geometry', async t => {
  const f = fixture(t);
  f.layer.update({ enabled: true, routes: [route], catalog: { ...catalog, terrain } });
  await f.render();
  const changed = { ...terrain, shards: terrain.shards.map(shard => ({ ...shard,
    file: `${'b'.repeat(64)}.terrain`, sha256: 'b'.repeat(64) })) };
  f.layer.update({ enabled: true, routes: [route], catalog: { ...catalog, terrain: changed } });
  await f.render(); await f.finish(0);
  assert.ok(f.canceled.includes(f.jobs[0]!.request.id));
  assert.ok(f.closed.includes(f.jobs[0]!.request.id));
  assert.equal(f.data().features.length, 0, 'a late result from the old source cannot restore geometry');
  assert.equal(f.jobs[1]!.request.packages?.[0]?.shard.sha256, 'b'.repeat(64));
  await f.finish(1);
  f.layer.update({ enabled: true, routes: [route], catalog: { ...catalog, terrain: { ...changed, root: '/replacement' } } });
  assert.equal(f.data().features.length, 0);
  await f.render(); await f.finish(2);
  assert.equal(f.jobs[2]!.request.packages?.[0]?.root, 'https://terrain.test/replacement');
  assert.equal(f.status().state, 'ready');
});

test('saved terrain health changes preserve tiles but removing a selected shard adopts the browsing source', async t => {
  const f = fixture(t), browsing = { ...catalog, terrain: { ...terrain, root: '/browsing' } };
  const saved: SavedBundle = { key: 'saved', catalog: { ...catalog, terrain }, bounds: [[-10, -1, 10, 1]],
    plan: { id: 'saved', regionId: 'saved', title: 'Saved', revision: catalog.revision, references: [],
      files: [{ kind: 'terrain', url: '/saved', sha256: terrain.shards[0]!.sha256, byteLength: 100 }] } };
  const update = (bundle: SavedBundle) => f.layer.update({ enabled: true, routes: [route],
    catalog: createWorkspaceReadContext(browsing, [bundle]) });
  update(saved); await f.render(); await f.finish(0);
  const data = f.data();
  assert.equal(f.jobs[0]!.request.packages?.[0]?.root, terrain.root);
  update({ ...structuredClone(saved), key: 'metadata-refreshed', unavailable: true });
  await f.render();
  assert.equal(f.data(), data); assert.equal(f.jobs.length, 1); assert.equal(f.status().state, 'ready');
  update({ ...saved, plan: { ...saved.plan, files: [] } });
  assert.equal(f.data().features.length, 0);
  await f.render(); await f.finish(1);
  assert.equal(f.jobs[1]!.request.packages?.[0]?.root, 'https://terrain.test/browsing');
  assert.equal(f.status().state, 'ready');
});

test('missing vectors recover with at most four jobs and cold raster loading does not duplicate work', async t => {
  const f = fixture(t); f.loaded(false); f.move(Array.from({ length: 6 }, (_, i) => tile(i)));
  await f.render(); assert.equal(f.jobs.length, 0); assert.equal(f.status().state, 'loading');
  f.loaded(true); await f.render(); assert.equal(f.jobs.length, 4);
  await f.render(); assert.equal(f.jobs.length, 4);
  await f.finish(0); await f.render(); assert.equal(f.jobs.length, 5);
  await f.finish(1); await f.render(); assert.equal(f.jobs.length, 6);
  for (let i = 2; i < 6; i++) await f.finish(i);
  assert.equal(f.data().features.length, 6); assert.equal(f.status().state, 'ready');
});

test('vectors evicted independently of raster tiles recover when revisited', async t => {
  const f = fixture(t);
  for (let i = 0; i < 130; i++) { f.move([tile(i)]); await f.render(); await f.finish(i); }
  f.move([tile(0)]);
  assert.equal(f.status().state, 'loading', 'missing geometry must not claim ready');
  await f.render(); assert.equal(f.jobs.length, 131);
  await f.finish(130);
  assert.equal(f.data().features[0]!.properties.elevation, 4000);
  assert.equal(f.status().state, 'ready');
});

test('recovery failures stop retrying and online explicitly retries the current route', async t => {
  const f = fixture(t); await f.render(); f.jobs[0]!.fail(); await settled();
  assert.equal(f.status().state, 'error');
  for (let i = 0; i < 10; i++) { await f.render(); await f.advance(); }
  assert.equal(f.jobs.length, 1);
  window.dispatchEvent(new Event('online')); await f.render(); await f.finish(1);
  assert.equal(f.status().state, 'ready');
});

test('worker construction failure is reported once instead of creating a recovery loop', async t => {
  const f = fixture(t);
  let attempts = 0;
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: class {
    constructor() { attempts++; throw new Error('Worker unavailable'); }
  } });
  for (let i = 0; i < 10; i++) await f.render();
  assert.equal(attempts, 1); assert.equal(f.status().state, 'error');
});

test('terrain source errors schedule a completion frame without repainting for unrelated errors', t => {
  const f = fixture(t);
  f.fire('error', { sourceId: TERRAIN_SOURCE }); assert.equal(f.repaints(), 1);
  f.fire('error', { sourceId: 'unrelated' }); f.fire('error', {});
  assert.equal(f.repaints(), 1); assert.equal(f.jobs.length, 0);
});

test('viewport shading does not schedule route-vector recovery and switching back restores it', async t => {
  const f = fixture(t); await f.render();
  f.layer.update({ enabled: true, routes: [], coverage: 'viewport' });
  await f.render(); await f.finish(0);
  assert.equal(f.jobs.length, 1); assert.equal(f.status().state, 'ready');
  assert.equal(f.sources.has(TERRAIN_CONTOUR_SOURCE), false);
  assert.equal(f.sources.has(TERRAIN_LABEL_SOURCE), false);
  assert.equal(f.sources.has(TERRAIN_CORRIDOR_SOURCE), false);
  assert.deepEqual(f.closed, [f.jobs[0]!.request.id]);
  f.layer.update({ enabled: true, routes: [route], coverage: 'route' });
  await f.render(); await f.finish(1);
  assert.equal(f.data().features.length, 1); assert.equal(f.status().state, 'ready');
  assert.equal(f.data(TERRAIN_CORRIDOR_SOURCE).features.length, 1);
});

test('corridor geometry follows route edits, stays stable on camera/altitude changes, and clears with the route', t => {
  const f = fixture(t), initial = f.data(TERRAIN_CORRIDOR_SOURCE);
  assert.equal(initial.features.length, 1, 'the boundary is available before elevation finishes loading');
  f.zoom(9.5); f.move([tile(1)]);
  f.layer.update({ enabled: true, routes: [route], altitude: 7500 });
  assert.equal(f.data(TERRAIN_CORRIDOR_SOURCE), initial);
  const changed = resolve('BBBB AAAA');
  f.layer.update({ enabled: true, routes: [changed] });
  assert.notEqual(f.data(TERRAIN_CORRIDOR_SOURCE), initial);
  f.layer.update({ enabled: true, routes: [] });
  assert.equal(f.data(TERRAIN_CORRIDOR_SOURCE).features.length, 0);
  f.layer.update({ enabled: false, routes: [route] });
  assert.equal(f.data(TERRAIN_CORRIDOR_SOURCE).features.length, 0);
});

test('pans, new routes, disable and unmount cancel obsolete recovery and close late bitmaps', async t => {
  const f = fixture(t); await f.render(); f.move([tile(1)]); await f.render();
  assert.ok(f.canceled.includes(f.jobs[0]!.request.id));
  await f.finish(0); assert.equal(f.data().features.length, 0);
  f.layer.update({ enabled: true, routes: [resolve('BBBB AAAA')] });
  await f.render(); await f.finish(1); assert.equal(f.data().features.length, 0);
  assert.ok(f.closed.includes(f.jobs[0]!.request.id) && f.closed.includes(f.jobs[1]!.request.id));
  await f.finish(2); assert.equal(f.status().state, 'ready');
  f.move([tile(2)]); await f.render(); f.layer.update({ enabled: false, routes: [route] });
  assert.ok(f.workers[0]!.terminated); assert.equal(f.status().state, 'idle');
  await f.render(); assert.equal(f.jobs.length, 4);
  f.layer.unmount(); await settled();
  assert.equal(f.sources.size, 0); assert.ok([...f.listeners.values()].every(set => set.size === 0));
  f.layer.update({ enabled: true, routes: [route] }); f.layer.mount(f.map); await f.render(); await f.finish(4);
  assert.equal(f.workers.length, 2); assert.equal(f.status().state, 'ready');
});

test('terrain labels keep their foreground position through edits, toggles and individual remounts', t => {
  const f = fixture(t); f.layer.unmount();
  const simple = (id: string, slot: LayerSlot) => ({ id, slot, foregroundLayerIds: [id],
    mount: () => f.map.addLayer({ id, type: 'background' }), unmount: () => f.map.removeLayer(id) });
  const host = new MapLayerHost(f.map, (_id, error) => { throw error; });
  t.after(() => host.unmount());
  const modules = [f.layer, simple('route-waypoint-labels', 'route'), simple('ownship-aircraft', 'ownship')];
  host.mount(modules);
  const initial = [...f.layers];
  for (const routes of [[resolve('BBBB AAAA')], [], [route]]) {
    host.update(f.layer, { enabled: true, routes }); assert.deepEqual(f.layers, initial);
  }
  host.update(f.layer, { enabled: false, routes: [route] }); assert.deepEqual(f.layers, initial);
  host.update(f.layer, { enabled: true, routes: [route] });
  f.layer.unmount(); f.layer.mount(f.map); assert.deepEqual(f.layers, initial);
  host.mount(modules); assert.deepEqual(f.layers, initial);
  host.unmount(); assert.deepEqual(f.layers, [TERRAIN_LAYER_ANCHOR]);
});

test('geographic coloring modes and altitude adjustments reuse the same rendered terrain', async t => {
  const f = fixture(t);
  const geographic: TerrainSource = { schemaVersion: 2, encoding: 'int16-metres-gzip', grid: 'EPSG:4326',
    minZoom: 1, maxZoom: 11, resolutionArcSeconds: 2.45, generatedAt: catalog.generatedAt, root: terrain.root,
    shards: terrain.shards.map(shard => ({ ...shard, zoom: 11, x: 960, y: 512 })) };
  const input = { enabled: true, routes: [route], catalog: { ...catalog, terrain: geographic } };
  f.layer.update({ ...input, altitude: 5500 });
  await f.render(); await f.finish(0);
  const contours = f.data();
  for (const altitude of [6000, null, 5500, null]) {
    f.layer.update({ ...input, altitude }); await f.render();
    assert.equal(f.jobs.length, 1, 'palette changes must not rebuild terrain');
    assert.equal(f.data(), contours);
    assert.equal(f.status().state, 'ready');
  }
});
