import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { MessageChannel } from 'node:worker_threads';
import { expose } from 'comlink';
import nodeEndpoint from 'comlink/dist/umd/node-adapter.js';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import type { CatalogResponse } from '@zlayer/contracts';
import { createGlideLayer, type GlideMapInput } from '../src/layers/glide/map';
import type { GlideRequest, GlideResponse, GlideRange, GlideStatus } from '../src/layers/glide/types';

function range(request: GlideRequest): GlideRange {
  const [x, y] = request.ownship!;
  const ring = [[x - .01, y - .01], [x + .01, y - .01], [x + .01, y + .01], [x - .01, y + .01], [x - .01, y - .01]];
  return { key: JSON.stringify(request.ownship), incomplete: false,
    line: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: [ring] } }] },
    area: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: [[ring]] } }] } };
}

function harness(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requests: GlideRequest[] = [], workers: TestWorker[] = [], statuses: GlideStatus[] = [];
  class TestWorker extends EventTarget {
    readonly channel = new MessageChannel();
    constructor() {
      super(); workers.push(this);
      this.channel.port1.on('message', data => this.dispatchEvent(new MessageEvent('message', { data })));
      expose({ calculate(request: GlideRequest): GlideResponse {
        requests.push(request);
        return { planRevision: 0, planKey: '', airportCount: 0, incomplete: false, point: null, ownship: range(request),
          work: { terrainSourceCells: 0, terrainCells: 0, profileCells: 0, profilesBuilt: 0, profilesReused: 0, planReused: true, footprintsReused: 0 } };
      }, cancel() {} }, nodeEndpoint(this.channel.port2));
    }
    postMessage(message: unknown, transfer: ArrayBuffer[]) { this.channel.port1.postMessage(message, transfer); }
    terminate() { this.channel.port1.close(); this.channel.port2.close(); }
  }
  let cleanup = () => {};
  t.after(() => { cleanup(); workers.forEach(worker => worker.terminate()); });
  for (const [name, value] of Object.entries({ Worker: TestWorker, window: new EventTarget(), BroadcastChannel: undefined,
    location: new URL('https://glide.test/'), document: Object.assign(new EventTarget(), { hidden: false }),
    requestAnimationFrame: (): number => 1, cancelAnimationFrame: (): void => {}, matchMedia: () => ({ matches: true }) })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, name, original) : Reflect.deleteProperty(globalThis, name));
  }
  const handlers = new Map<string, Set<(event: unknown) => void>>(), sources = new Set<string>();
  const layers = new Map<string, { source: string }>(), visibility = new Map<string, unknown>();
  const uploads: { id: string; finish: () => void }[] = [];
  let moving = false;
  const map = {
    getZoom: () => 12, isMoving: () => moving, getCenter: () => ({ lng: 0, lat: 0 }),
    getCanvas: () => ({ clientWidth: 100, clientHeight: 100 }),
    project: ([lng, lat]: number[]) => ({ x: 50 + lng! * 500, y: 50 - lat! * 500 }),
    unproject: ([x, y]: number[]) => ({ lng: (x! - 50) / 500, lat: (50 - y!) / 500 }),
    addSource: (id: string) => sources.add(id), removeSource: (id: string) => sources.delete(id),
    getSource: (id: string) => sources.has(id) ? { setData(data: FeatureCollection) {
      return data.features.length ? new Promise<void>(finish => uploads.push({ id, finish })) : Promise.resolve();
    } } : undefined,
    addLayer: ({ id, source }: { id: string; source: string }) => layers.set(id, { source }),
    getLayer: (id: string) => layers.get(id), removeLayer: (id: string) => layers.delete(id),
    getLayoutProperty: (id: string) => visibility.get(id),
    setLayoutProperty: (id: string, _key: string, value: unknown) => visibility.set(id, value), setPaintProperty() {},
    on(type: string, callback: (event: unknown) => void) { const set = handlers.get(type) ?? new Set(); set.add(callback); handlers.set(type, set); },
    off(type: string, callback: (event: unknown) => void) { handlers.get(type)?.delete(callback); },
  } as unknown as MapLibreMap;
  const catalog: CatalogResponse = { schemaVersion: 1, revision: 'test', generatedAt: '2026-10-04T00:00:00Z', charts: [], navigation: [], weather: [] };
  let input: GlideMapInput = { enabled: true, airportsEnabled: false, ratio: 10, altitude: 5000, catalog, retry: 0, ownship: [0, 0] };
  const layer = createGlideLayer(status => statuses.push(status));
  const update = (patch: Partial<GlideMapInput>) => { input = { ...input, ...patch }; layer.update(input); };
  cleanup = () => layer.unmount(); update({}); layer.mount(map);
  const settle = async () => { for (let i = 0; i < 10; i++) await setImmediate(); };
  const advance = async (ms: number) => { t.mock.timers.tick(ms); await settle(); };
  const fire = (type: string, event: unknown = {}) => handlers.get(type)?.forEach(callback => callback(event));
  return { layer, map, requests, uploads, statuses, handlers, update, settle, advance, fire, moving(value: boolean) { moving = value; } };
}

test('ownship upload failure and remount release animation backpressure without waiting for old promises', async t => {
  const h = harness(t);
  await h.advance(180);
  assert.equal(h.requests.length, 1); assert.equal(h.uploads.length, 2);
  h.fire('error', { sourceId: 'glide-ownship', error: new Error('Source failed without settling') });
  assert.equal(h.statuses.at(-1)!.state, 'error');
  await h.advance(100);
  assert.equal(h.uploads.length, 4, 'fill and outline receive one retained-data retry');
  h.uploads[2]!.finish(); h.uploads[3]!.finish(); await h.settle();
  assert.equal(h.statuses.at(-1)!.state, 'ready');
  h.update({ ownship: [.0004, 0] }); await h.advance(250);
  assert.equal(h.requests.length, 2); assert.equal(h.uploads.length, 6, 'the next fix publishes while the failed original promises are unresolved');
  h.uploads[0]!.finish(); h.uploads[1]!.finish(); await h.settle();
  assert.equal(h.statuses.at(-1)!.state, 'ready');
  h.layer.unmount(); h.layer.mount(h.map); await h.advance(180);
  assert.equal(h.requests.length, 3); assert.equal(h.uploads.length, 8, 'the same adapter can remount with an old upload still pending');
  h.uploads[4]!.finish(); h.uploads[5]!.finish(); await h.settle();
  h.uploads[6]!.finish(); h.uploads[7]!.finish(); await h.settle();
  assert.equal(h.statuses.at(-1)!.state, 'ready');
});

test('range demand deferred by camera motion resumes on idle and does no recurring work', async t => {
  const h = harness(t);
  h.moving(true); await h.advance(180);
  assert.equal(h.requests.length, 0);
  h.fire('idle'); await h.advance(180); assert.equal(h.requests.length, 0);
  h.moving(false); h.fire('idle'); await h.advance(180);
  assert.equal(h.requests.length, 1);
  h.uploads.forEach(upload => upload.finish()); await h.settle();
  h.fire('idle'); await h.advance(60_000);
  assert.equal(h.requests.length, 1, 'source idle events do not recalculate terrain');
  h.moving(true); h.fire('movestart'); h.moving(false); h.fire('idle'); await h.advance(180);
  assert.equal(h.requests.length, 2, 'a gesture without moveend retains its demand');
  h.moving(true); h.fire('movestart'); h.update({ enabled: false });
  h.moving(false); h.fire('idle'); await h.advance(1000);
  assert.equal(h.requests.length, 2, 'disable discards deferred demand');
  h.layer.unmount();
  assert.ok([...h.handlers.values()].every(set => !set.size));
});
