import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { MessageChannel } from 'node:worker_threads';
import { expose } from 'comlink';
import nodeEndpoint from 'comlink/dist/umd/node-adapter.js';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { createLandingLayer, type LandingInput } from '../src/layers/glide/landing-map';
import { emptyLandings, type LandingStatus } from '../src/layers/glide/landing-data';
import type { LandingDisplayWorker, LandingDisplayResult, LandingDisplayQuery } from '../src/layers/glide/landing-display';
import { emptyAreas } from '../src/layers/glide/types';

function harness(t: TestContext, more = (_batch: number) => false,
  respond?: (request: LandingDisplayQuery, batch: number) => Promise<LandingDisplayResult>) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const requests: Parameters<LandingDisplayWorker['query']>[0][] = [], workers: TestWorker[] = [];
  class TestWorker extends EventTarget {
    readonly channel = new MessageChannel();
    constructor() {
      super(); workers.push(this);
      this.channel.port1.on('message', data => this.dispatchEvent(new MessageEvent('message', { data })));
      expose({ query(request: Parameters<LandingDisplayWorker['query']>[0]) {
        requests.push(request);
        return respond ? respond(request, requests.length) : { renderKey: `heat/detail-${requests.length}`, collection: emptyLandings(),
          status: { state: 'ready' }, more: more(requests.length), refreshed: true };
      }, cancel() {} }, nodeEndpoint(this.channel.port2));
    }
    postMessage(message: unknown, transfer: ArrayBuffer[]) { this.channel.port1.postMessage(message, transfer); }
    terminate() { this.channel.port1.close(); this.channel.port2.close(); }
  }
  let cleanup = () => {};
  t.after(() => { cleanup(); workers.forEach(worker => worker.terminate()); });
  for (const [name, value] of Object.entries({ Worker: TestWorker, window: new EventTarget(),
    location: new URL('https://example.test'), BroadcastChannel: undefined,
    ImageData: class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} },
    document: Object.assign(new EventTarget(), { hidden: false }) })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, name, original) : Reflect.deleteProperty(globalThis, name));
  }
  const handlers = new Map<string, Set<(event: unknown) => void>>();
  const sources = new Set<string>(), layers = new Set<string>(), visibility = new Map<string, unknown>();
  const uploads: (() => void)[] = [], statuses: LandingStatus[] = [], images: { id: string; image: ImageData }[] = [];
  let moving = false;
  const map = {
    getZoom: () => 12, isMoving: () => moving, triggerRepaint: () => {},
    getBounds: () => ({ getWest: () => -1, getEast: () => 1, getSouth: () => -1, getNorth: () => 1 }),
    addSource: (id: string) => sources.add(id), removeSource: (id: string) => sources.delete(id),
    getSource: (id: string) => ({ setData: () => new Promise<void>(resolve => uploads.push(resolve)),
      updateImage: ({ image }: { image: ImageData }) => images.push({ id, image }) }),
    addLayer: ({ id }: { id: string }) => layers.add(id), getLayer: (id: string) => layers.has(id),
    removeLayer: (id: string) => layers.delete(id), getLayoutProperty: (id: string) => visibility.get(id),
    setLayoutProperty: (id: string, _key: string, value: unknown) => visibility.set(id, value),
    on(type: string, callback: (event: unknown) => void) { const set = handlers.get(type) ?? new Set(); set.add(callback); handlers.set(type, set); },
    off(type: string, callback: (event: unknown) => void) { handlers.get(type)?.delete(callback); },
  } as unknown as MapLibreMap;
  const layer = createLandingLayer(status => statuses.push(status));
  cleanup = () => layer.unmount();
  let input: LandingInput = { enabled: true, segments: [[[.5, .5], [.6, .6]]], ranges: emptyAreas(), retry: 0 };
  const update = (patch: Partial<LandingInput>) => { input = { ...input, ...patch }; layer.update(input); };
  update({}); layer.mount(map);
  const settle = async () => { for (let i = 0; i < 10; i++) await setImmediate(); };
  const advance = async (ms: number) => { t.mock.timers.tick(ms); await settle(); };
  const fire = (type: string, event: unknown = {}) => handlers.get(type)?.forEach(callback => callback(event));
  return { layer, uploads, images, statuses, requests, advance, settle, fire, handlers, update, moving: (value: boolean) => { moving = value; } };
}

test('a late failed landing upload cannot overwrite its successful retry receipt', async t => {
  const { layer, uploads, statuses, requests, advance, settle, fire, handlers } = harness(t);
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

test('progress continues without another debounce and stops on movement, hiding, completion and teardown', async t => {
  const { layer, uploads, requests, advance, settle, fire } = harness(t, batch => [1, 2, 4, 6].includes(batch));
  await advance(149); assert.equal(requests.length, 0);
  await advance(1); assert.equal(requests.length, 1);
  uploads[0]!(); await settle();
  await advance(0); assert.equal(requests.length, 2, 'accepted work continues without another 150 ms delay');
  uploads[1]!(); await settle();
  fire('movestart'); await advance(1000);
  assert.equal(requests.length, 2, 'manual movement cancels the queued continuation');
  fire('moveend'); await advance(150);
  assert.equal(requests.length, 3);
  uploads[2]!(); await settle();
  await advance(60_000); assert.equal(requests.length, 3, 'a complete view has no polling timer');

  fire('moveend'); await advance(150);
  uploads[3]!(); await settle();
  Object.assign(document, { hidden: true }); document.dispatchEvent(new Event('visibilitychange'));
  await advance(60_000); assert.equal(requests.length, 4, 'hidden views do not continue preparing');
  Object.assign(document, { hidden: false }); document.dispatchEvent(new Event('visibilitychange'));
  await advance(150); assert.equal(requests.length, 5);
  uploads[4]!(); await settle();
  fire('moveend'); await advance(150);
  uploads[5]!(); await settle();
  layer.unmount(); await advance(60_000);
  assert.equal(requests.length, 6, 'teardown releases the continuation');
});

test('a failed unsettled vector upload cannot stall progressive heat preparation', async t => {
  const { uploads, statuses, requests, advance, settle, fire } = harness(t, batch => batch === 1);
  await advance(150);
  fire('error', { sourceId: 'glide-landing-areas', error: new Error('Upload failed without settling') });
  await settle(); await advance(0);
  assert.equal(requests.length, 2, 'the next heat batch must not wait for the failed upload promise');
  uploads[1]!(); await settle();
  assert.equal(statuses.at(-1)!.state, 'ready');
  uploads[0]!(); await settle();
  assert.equal(statuses.at(-1)!.state, 'ready', 'late failed completion cannot overwrite recovery');
  await advance(60_000);
  assert.equal(requests.length, 2, 'completed recovery does not poll');
});

test('camera-blocked demand resumes on idle without another zoom and then stays idle', async t => {
  const { layer, uploads, requests, advance, settle, fire, moving } = harness(t);
  moving(true); await advance(150);
  assert.equal(requests.length, 0);
  fire('idle'); await advance(150);
  assert.equal(requests.length, 0, 'idle cannot admit work while the camera is still moving');
  moving(false); fire('idle'); await advance(150);
  assert.equal(requests.length, 1, 'remember the demand whose timer expired during movement');
  uploads[0]!(); await settle();
  fire('idle'); await advance(60_000);
  assert.equal(requests.length, 1, 'source-generated idle events do not create a render loop');
  moving(true); fire('movestart'); await advance(1000);
  assert.equal(requests.length, 1);
  moving(false); fire('idle'); await advance(150);
  assert.equal(requests.length, 2, 'idle also recovers demand canceled at gesture start');
  uploads[1]!(); await settle();
  moving(true); fire('movestart'); layer.unmount(); moving(false); fire('idle'); await advance(1000);
  assert.equal(requests.length, 2, 'teardown removes deferred camera demand');
});

test('range changes retain ready heat and continue with the newest detail demand', async t => {
  const replies: ((result: LandingDisplayResult) => void)[] = [];
  const h = harness(t, () => false, () => new Promise(resolve => replies.push(resolve)));
  await h.advance(150);
  h.update({ ranges: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: {
    type: 'MultiPolygon', coordinates: [[[[0, 0], [.1, 0], [.1, .1], [0, .1], [0, 0]]]],
  } }] } });
  replies[0]!({ renderKey: 'ready-heat/', heat: [{ key: 'tile', extent: [.49, .49, .51, .51], vertices: new Float32Array([0, 0, 1, 0, 0, 1]),
    levels: [{ width: 1, height: 1, shadedCells: 1, rgba: new Uint8ClampedArray([83, 229, 45, 200]) }] }], collection: emptyLandings(), more: true, refreshed: true, status: { state: 'loading' } });
  await h.settle();
  await h.advance(0);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1]!.renderedKey, 'ready-heat/');
  assert.deepEqual(h.requests[1]!.heatTiles, ['tile'], 'a moving range retains the accepted route tile');
  assert.equal(h.requests[1]!.revalidate, false, 'the completed refresh is acknowledged with the heat');
  assert.equal(h.requests[1]!.ranges?.features.length, 1);
  assert.equal(h.uploads.length, 1, 'only the range-clear upload precedes the new detail result');
});

test('canceled refreshes remain pending, while failed refreshes cool down without polling', async t => {
  const replies: ((result: LandingDisplayResult) => void)[] = [];
  const h = harness(t, () => false, () => new Promise(resolve => replies.push(resolve)));
  const reply = (refreshed: boolean): LandingDisplayResult => ({ renderKey: 'heat/detail', collection: emptyLandings(),
    more: false, refreshed, status: { state: refreshed ? 'ready' : 'partial' } });
  await h.advance(150);
  assert.equal(h.requests[0]!.revalidate, true);
  h.fire('movestart'); h.fire('moveend'); replies[0]!(reply(true)); await h.settle(); await h.advance(150);
  assert.equal(h.requests[1]!.revalidate, true, 'dispatching a canceled refresh does not consume it');
  replies[1]!(reply(false)); await h.settle(); h.uploads[0]!(); await h.settle();
  h.fire('moveend'); await h.advance(150);
  assert.equal(h.requests[2]!.revalidate, false, 'failed manifests do not retry on every immediate demand');
  replies[2]!(reply(false)); await h.settle(); h.uploads[1]!(); await h.settle();
  await h.advance(60_000);
  assert.equal(h.requests.length, 3, 'cooldown itself schedules no background work');
  h.fire('moveend'); await h.advance(150);
  assert.equal(h.requests[3]!.revalidate, true, 'later demand retries the pending refresh');
});

test('camera cancellation releases a pending upload without treating it as a source failure', async t => {
  const h = harness(t);
  await h.advance(150);
  h.fire('movestart'); h.fire('moveend'); await h.settle(); await h.advance(150);
  assert.equal(h.requests.length, 2, 'camera recovery does not wait for an obsolete setData promise');
  h.uploads[1]!(); await h.settle();
  h.uploads[0]!(); await h.settle();
  assert.equal(h.statuses.at(-1)!.state, 'ready');
  assert.equal(h.statuses.some(status => status.state === 'error'), false, 'cancellation is not a source failure');
});

test('route changes reject old heat while accepted heat survives later vector failures', async t => {
  const replies: ((result: LandingDisplayResult) => void)[] = [];
  const h = harness(t, () => false, () => new Promise(resolve => replies.push(resolve)));
  const result: LandingDisplayResult = { renderKey: 'heat/detail', heat: [{ key: 'tile', extent: [.49, .49, .51, .51], vertices: new Float32Array([0, 0, 1, 0, 0, 1]),
    levels: [{ width: 1, height: 1, shadedCells: 1, rgba: new Uint8ClampedArray([83, 229, 45, 200]) }] }], collection: emptyLandings(),
    status: { state: 'ready' }, more: false, refreshed: true };
  await h.advance(150);
  h.update({ segments: [[[.5, .5], [.7, .7]]] });
  replies[0]!(result); await h.settle();
  await h.advance(150);
  assert.deepEqual(h.requests[1]!.heatTiles, [], 'obsolete route replies cannot populate retained tiles');
  replies[1]!(result); await h.settle();
  h.fire('error', { sourceId: 'glide-landing-areas', error: new Error('Vector processing failed') });
  await h.settle(); h.fire('moveend'); await h.advance(150);
  assert.deepEqual(h.requests[2]!.heatTiles, ['tile']);
  assert.equal(h.requests[2]!.renderedKey, 'heat/', 'vector recovery only revokes the detail acknowledgment');
});
