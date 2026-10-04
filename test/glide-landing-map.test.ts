import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { MessageChannel } from 'node:worker_threads';
import { expose } from 'comlink';
import nodeEndpoint from 'comlink/dist/umd/node-adapter.js';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { createLandingLayer } from '../src/layers/glide/landing-map';
import { emptyLandings, type LandingStatus } from '../src/layers/glide/landing-data';
import type { LandingDisplayWorker } from '../src/layers/glide/landing-display';
import { emptyAreas } from '../src/layers/glide/types';

test('a late failed landing upload cannot overwrite its successful retry receipt', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requests: Parameters<LandingDisplayWorker['query']>[0][] = [], workers: TestWorker[] = [];
  class TestWorker extends EventTarget {
    readonly channel = new MessageChannel();
    constructor() {
      super(); workers.push(this);
      this.channel.port1.on('message', data => this.dispatchEvent(new MessageEvent('message', { data })));
      expose({ query(request: Parameters<LandingDisplayWorker['query']>[0]) {
        requests.push(request);
        return { renderKey: `heat/detail-${requests.length}`, collection: emptyLandings(), status: { state: 'ready' } };
      }, cancel() {} }, nodeEndpoint(this.channel.port2));
    }
    postMessage(message: unknown, transfer: ArrayBuffer[]) { this.channel.port1.postMessage(message, transfer); }
    terminate() { this.channel.port1.close(); this.channel.port2.close(); }
  }
  let cleanup = () => {};
  t.after(() => { cleanup(); workers.forEach(worker => worker.terminate()); });
  for (const [name, value] of Object.entries({ Worker: TestWorker, window: new EventTarget(),
    location: new URL('https://example.test'), BroadcastChannel: undefined,
    document: Object.assign(new EventTarget(), { hidden: false }) })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, name, original) : Reflect.deleteProperty(globalThis, name));
  }
  const handlers = new Map<string, Set<(event: unknown) => void>>();
  const sources = new Set<string>(), layers = new Set<string>(), visibility = new Map<string, unknown>();
  const uploads: (() => void)[] = [], statuses: LandingStatus[] = [];
  const map = {
    getZoom: () => 12, isMoving: () => false,
    getBounds: () => ({ getWest: () => -1, getEast: () => 1, getSouth: () => -1, getNorth: () => 1 }),
    addSource: (id: string) => sources.add(id), removeSource: (id: string) => sources.delete(id),
    getSource: () => ({ setData: () => new Promise<void>(resolve => uploads.push(resolve)) }),
    addLayer: ({ id }: { id: string }) => layers.add(id), getLayer: (id: string) => layers.has(id),
    removeLayer: (id: string) => layers.delete(id), getLayoutProperty: (id: string) => visibility.get(id),
    setLayoutProperty: (id: string, _key: string, value: unknown) => visibility.set(id, value),
    on(type: string, callback: (event: unknown) => void) { const set = handlers.get(type) ?? new Set(); set.add(callback); handlers.set(type, set); },
    off(type: string, callback: (event: unknown) => void) { handlers.get(type)?.delete(callback); },
  } as unknown as MapLibreMap;
  const layer = createLandingLayer(status => statuses.push(status));
  cleanup = () => layer.unmount();
  layer.update({ enabled: true, segments: [[[.5, .5], [.6, .6]]], ranges: emptyAreas(), retry: 0 }); layer.mount(map);
  const settle = async () => { for (let i = 0; i < 10; i++) await setImmediate(); };
  const advance = async (ms: number) => { t.mock.timers.tick(ms); await settle(); };
  const fire = (type: string, event: unknown = {}) => handlers.get(type)?.forEach(callback => callback(event));
  await advance(150); uploads[0]!(); await settle();
  assert.equal(statuses.at(-1)!.state, 'ready');
  fire('moveend'); await advance(150);
  assert.equal(requests[1]!.renderedKey, 'heat/detail-1');
  fire('error', { sourceId: 'glide-landing-areas', error: new Error('Worker failed before settling') });
  assert.equal(statuses.at(-1)!.state, 'error');
  await advance(100); uploads[2]!(); await settle();
  assert.equal(statuses.at(-1)!.state, 'ready', 'retry owns the newest prepared receipt');
  uploads[1]!(); await settle();
  assert.equal(statuses.at(-1)!.state, 'ready', 'late original completion cannot restore an error');
  fire('moveend'); await advance(150);
  assert.equal(requests[2]!.renderedKey, 'heat/detail-2');
  layer.unmount(); uploads[3]!(); await settle();
  assert.equal(statuses.at(-1)!.state, 'idle');
  assert.ok([...handlers.values()].every(set => !set.size));
});
