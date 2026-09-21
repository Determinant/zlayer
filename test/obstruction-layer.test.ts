import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { MessageChannel } from 'node:worker_threads';
import { expose } from 'comlink';
import nodeEndpoint from 'comlink/dist/umd/node-adapter.js';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { Bounds } from '@zlayer/contracts';
import { createObstructionLayer } from '../src/layers/obstructions/layer';
import { ObstructionIndex } from '../src/layers/obstructions/data';
import { OBSTRUCTION_SOURCE } from '../src/layers/obstructions/definitions';
import { obstructionBoundsContain } from '../src/layers/obstructions/coverage';
import type { ObstructionCollection, ObstructionRequest, ObstructionResult, ObstructionStatus } from '../src/layers/obstructions/types';
import { createRouteRemovalResolver } from './helpers/route-removal';

async function settled() { for (let i = 0; i < 10; i++) await setImmediate(); }

function fixture(t: test.TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const jobs: { request: ObstructionRequest; finish: (result?: ObstructionResult) => void; fail: () => void }[] = [];
  const workers: TestWorker[] = [], statuses: ObstructionStatus[] = [], writes: ObstructionCollection[] = [];
  const index = new ObstructionIndex(4);
  [0, 1.25, -1.75, 2.5].forEach((lon, i) => index.add({ type: 'Feature', id: `06-00000${i + 1}`,
    geometry: { type: 'Point', coordinates: [lon, 0] }, properties: { heightAglFt: 500, elevationMslFt: 550,
      quantity: 1, lightingCode: 'N', structureType: 'TOWER', verified: true } }));
  index.finish();
  class TestWorker extends EventTarget {
    readonly channel = new MessageChannel();
    terminated = false;
    constructor() {
      super(); workers.push(this);
      this.channel.port1.on('message', data => this.dispatchEvent(new MessageEvent('message', { data })));
      expose({ query: (request: ObstructionRequest) => new Promise<ObstructionResult>((resolve, reject) => {
        jobs.push({ request, finish: (result) => resolve(result ?? {
          collection: index.query(request.bounds, request.segments, request.zoom), sourceDate: '2026-09-18',
        }), fail: () => reject(new Error('Fixture download unavailable')) });
      }) }, nodeEndpoint(this.channel.port2));
    }
    postMessage(message: unknown, transfer: ArrayBuffer[]) { this.channel.port1.postMessage(message, transfer); }
    terminate() { this.terminated = true; this.channel.port1.close(); this.channel.port2.close(); }
  }
  const noop = () => {};
  const context = { scale: noop, translate: noop, save: noop, restore: noop, stroke: noop, fill: noop,
    beginPath: noop, arc: noop, getImageData: () => ({ width: 72, height: 72, data: new Uint8ClampedArray(72 * 72 * 4) }) };
  let cleanup = () => {};
  t.after(() => cleanup());
  for (const [name, value] of Object.entries({ Worker: TestWorker, window: new EventTarget(), location: new URL('https://charts.test/'),
    document: { createElement: () => ({ getContext: () => context }) },
    Path2D: class { moveTo = noop; lineTo = noop; quadraticCurveTo = noop; closePath = noop; },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : Reflect.deleteProperty(globalThis, name));
  }
  let bounds: Bounds = [-1, -1, 1, 1], zoom = 10;
  const listeners = new Map<string, Set<() => void>>(), sources = new Map<string, ObstructionCollection>();
  const layers = new Set<string>(), images = new Set<string>();
  const map = {
    getZoom: () => zoom, getBounds: () => ({ getWest: () => bounds[0], getSouth: () => bounds[1], getEast: () => bounds[2], getNorth: () => bounds[3] }),
    on(event: string, handler: () => void) { const set = listeners.get(event) ?? new Set(); set.add(handler); listeners.set(event, set); },
    off: (event: string, handler: () => void) => listeners.get(event)?.delete(handler),
    addSource: (id: string, source: { data: ObstructionCollection }) => sources.set(id, source.data),
    getSource: (id: string) => sources.has(id) ? { setData(data: ObstructionCollection) { sources.set(id, data); writes.push(data); } } : undefined,
    removeSource: (id: string) => sources.delete(id),
    addLayer: (value: { id: string }) => layers.add(value.id), getLayer: (id: string) => layers.has(id), removeLayer: (id: string) => layers.delete(id),
    addImage: (id: string) => images.add(id), hasImage: (id: string) => images.has(id), removeImage: (id: string) => images.delete(id),
  } as unknown as MapLibreMap;
  const layer = createObstructionLayer(status => statuses.push(status));
  layer.update({ enabled: true, routes: [] }); layer.mount(map);
  const fire = (event: string) => listeners.get(event)?.forEach(handler => handler());
  const advance = async (ms = 80) => { t.mock.timers.tick(ms); await settled(); };
  const finish = async (i: number, result?: ObstructionResult) => { jobs[i]!.finish(result); await settled(); };
  cleanup = () => { layer.unmount(); workers.forEach(worker => worker.terminate()); };
  return { layer, map, jobs, workers, statuses, writes, sources, listeners, advance, finish, fire,
    data: () => sources.get(OBSTRUCTION_SOURCE)!, status: () => statuses.at(-1)!,
    move(center: number, event = 'move') { bounds = [center - 1, -1, center + 1, 1]; fire(event); },
    zoom(value: number) { zoom = value; fire('move'); fire('moveend'); },
    resize(value: Bounds) { bounds = value; fire('resize'); },
  };
}

test('nearby panning reuses buffered points and only counts the actual view', async t => {
  const f = fixture(t); await f.advance(); await f.finish(0);
  assert.equal(f.data().features.length, 3);
  assert.equal(f.status().count, 1);
  const published = f.data(); f.writes.length = 0;
  for (const center of [0.2, 0.3, -0.2, 0]) { f.move(center); f.fire('moveend'); await f.advance(); }
  assert.equal(f.jobs.length, 1); assert.equal(f.writes.length, 0);
  assert.equal(f.data(), published);
  f.move(0.3, 'moveend');
  assert.equal(f.status().count, 2, 'the prefetched point is now in view without a source update');
  assert.equal(f.status().sourceDate, '2026-09-18');
});

test('continuous pans refill before moveend without restarting the throttle or queuing duplicate queries', async t => {
  const f = fixture(t); await f.advance(); await f.finish(0);
  f.move(0.6); await f.advance(40); f.move(0.65); await f.advance(40);
  assert.equal(f.jobs.length, 2, 'movement must not postpone the query until the gesture ends');
  assert.ok(obstructionBoundsContain(f.jobs[1]!.request.bounds, [-0.35, -1, 1.65, 1]));
  for (const center of [0.7, 0.8, 0.9, 1]) { f.move(center); await f.advance(); }
  assert.equal(f.jobs.length, 2, 'only one worker query may be in flight');
  await f.finish(1); await f.advance();
  assert.equal(f.jobs.length, 2); assert.equal(f.status().state, 'ready');
  assert.equal(f.status().count, 2);
});

test('a slow initial query is discarded after a distant pan and only the latest view is queried next', async t => {
  const f = fixture(t); await f.advance();
  for (const center of [10, 20, 30]) { f.move(center); await f.advance(); }
  assert.equal(f.jobs.length, 1);
  await f.finish(0); assert.equal(f.writes.length, 0);
  await f.advance(); assert.equal(f.jobs.length, 2);
  assert.ok(obstructionBoundsContain(f.jobs[1]!.request.bounds, [29, -1, 31, 1]));
  await f.finish(1); assert.equal(f.status().state, 'ready'); assert.equal(f.status().count, 0);
});

test('reversing a pan into the warm buffer avoids replacing it with a distant result', async t => {
  const f = fixture(t); await f.advance(); await f.finish(0);
  const original = f.data(); f.writes.length = 0;
  f.move(10); await f.advance(); f.move(0, 'moveend');
  assert.equal(f.status().state, 'ready');
  await f.finish(1); await f.advance();
  assert.equal(f.jobs.length, 2); assert.equal(f.data(), original); assert.equal(f.writes.length, 0);
});

test('zoom tiers refill, failures do not spin, and online retries bypass the buffer', async t => {
  const f = fixture(t); await f.advance(); await f.finish(0);
  f.zoom(10.5); await f.advance(); assert.equal(f.jobs.length, 1);
  f.zoom(9.99); await f.advance(); assert.equal(f.jobs.length, 2);
  f.jobs[1]!.fail(); await settled();
  assert.equal(f.status().state, 'error'); assert.equal(f.data().features.length, 0);
  await f.advance(1000); assert.equal(f.jobs.length, 2);
  window.dispatchEvent(new Event('online')); await f.advance(); await f.finish(2);
  assert.equal(f.status().state, 'ready'); assert.equal(f.status().minHeightAglFt, 1000);
  f.zoom(6.99); await f.advance(); assert.equal(f.status().state, 'zoom'); assert.equal(f.jobs.length, 3);
});

test('a failed overlapping refill cannot erase a warm buffer after reversing direction', async t => {
  const f = fixture(t); await f.advance(); await f.finish(0);
  const original = f.data(); f.writes.length = 0;
  f.move(0.6); await f.advance(); f.move(0, 'moveend');
  f.jobs[1]!.fail(); await settled(); await f.advance();
  assert.equal(f.status().state, 'ready'); assert.equal(f.status().count, 1);
  assert.equal(f.data(), original); assert.equal(f.writes.length, 0); assert.equal(f.jobs.length, 2);
});

test('route changes remove old corridor contributions immediately and reject their delayed results', async t => {
  const f = fixture(t), resolve = createRouteRemovalResolver(), route = resolve('KSBA KSMX');
  await f.advance(); await f.finish(0);
  const result = structuredClone(f.data());
  result.features.forEach((point, i) => { point.properties.routeOpacity = 1; point.properties.minZoom = i ? 10 : 7; });
  f.zoom(7); f.layer.update({ enabled: true, routes: [route] }); await f.advance();
  await f.finish(1, { collection: result });
  f.layer.update({ enabled: true, routes: [resolve('KSBA ENTRY KSMX')] });
  assert.equal(f.data().features.length, 1); assert.equal(f.data().features[0]!.properties.routeOpacity, 0);
  await f.advance();
  f.layer.update({ enabled: true, routes: [] }); await f.advance();
  assert.equal(f.jobs.length, 3);
  await f.finish(2, { collection: result });
  assert.equal(f.data().features.length, 1, 'an old corridor cannot be republished');
  await f.advance(); assert.equal(f.jobs.length, 4); assert.deepEqual(f.jobs[3]!.request.segments, []);
  f.zoom(6.99); await f.finish(3, { collection: result }); await f.advance();
  assert.equal(f.status().state, 'zoom'); assert.equal(f.data().features.length, 0); assert.equal(f.jobs.length, 4);
});

test('resize, disable and remount release pending work and invalidate coverage', async t => {
  const f = fixture(t); await f.advance(); await f.finish(0);
  f.resize([-2, -2, 2, 2]); await f.advance(); assert.equal(f.jobs.length, 2);
  f.layer.update({ enabled: false, routes: [] });
  assert.ok(f.workers[0]!.terminated); assert.equal(f.status().state, 'idle');
  await f.finish(1); assert.equal(f.data().features.length, 0);
  f.layer.update({ enabled: true, routes: [] }); await f.advance();
  assert.equal(f.workers.length, 2); await f.finish(2);
  f.move(10); await f.advance(); f.layer.unmount(); await settled();
  assert.equal(f.sources.size, 0); assert.ok([...f.listeners.values()].every(handlers => handlers.size === 0));
  assert.ok(f.workers[1]!.terminated);
  f.layer.mount(f.map); await f.advance(); await f.finish(4);
  assert.equal(f.workers.length, 3); assert.equal(f.status().state, 'ready');
});
