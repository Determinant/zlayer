import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { Evented, Style } from 'maplibre-gl';
import { MapLayerHost } from '../src/core/map/layer';

class FakeMap {
  static instances: FakeMap[] = [];
  static failControl = false;
  touchZoomRotate = { _touchRotate: { _move() {} } };
  controls = 0;
  removals = 0;
  zoom = 9;
  sources = new Map<string, object>();
  getSource(id: string) { return this.sources.get(id); }
  listeners = new Map<string, Array<(event: object) => void>>();
  constructor() { FakeMap.instances.push(this); }
  on(type: string, listener: (event: object) => void) {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]); return this;
  }
  fire(type: string, event: object = {}) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  triggerRepaint() {}
  addControl() { if (++this.controls === 2 && FakeMap.failControl) throw new Error('control setup'); }
  getBounds() { return { getWest: () => -123, getSouth: () => 37, getEast: () => -122, getNorth: () => 38 }; }
  getCenter() { return { lng: -122.5, lat: 37.5 }; }
  getZoom() { return this.zoom; }
  getBearing() { return 0; }
  getPitch() { return 0; }
  remove() { this.removals++; }
}
Object.assign(globalThis, { testRuntimeMap: FakeMap });
const moduleUrl = (source: string) => 'data:text/javascript,' + encodeURIComponent(source);
const modules = new Map([
  ['maplibre-gl', 'export class AttributionControl {} export function setWorkerUrl() {}'],
  ['maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url', 'export default "worker.js";'],
  ['../../core/map/map', 'export const Map = globalThis.testRuntimeMap;'],
  ['./navigation-control', 'export class MapNavigationControl { getTargetBearing() { return 0; } }'],
  ['./style', 'export const DEFAULT_MAP_VIEW = {}; export const mapStyle = () => ({});'],
]);
const loader = registerHooks({ resolve(specifier, context, next) {
  const source = context.parentURL?.includes('/workspace/map/runtime') ? modules.get(specifier) : undefined;
  return source === undefined ? next(specifier, context) : { url: moduleUrl(source), shortCircuit: true };
} });
const { MapRuntime } = await import('../src/workspace/map/runtime');
loader.deregister();
Reflect.deleteProperty(globalThis, 'testRuntimeMap');

function environment(t: test.TestContext) {
  FakeMap.instances = []; FakeMap.failControl = false;
  const window = new EventTarget(), document = new EventTarget();
  const originals = ['window', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.assign(globalThis, { window, document });
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return { assertReleased() {
    assert.equal(FakeMap.instances.at(-1)?.removals, 1);
    assert.deepEqual(getEventListeners(window, 'pagehide'), []);
    assert.deepEqual(getEventListeners(document, 'visibilitychange'), []);
  } };
}
const options = () => ({
  container: {} as HTMLElement, contributions: [],
  orientation: { getSnapshot: () => ({ enabled: false, state: 'disabled', centerRequest: 0 }), subscribe: () => () => {} },
  onViewportChange() {}, onError(message: string) { assert.fail(message); },
});

test('failed map control setup removes the allocated map', t => {
  const { assertReleased } = environment(t);
  FakeMap.failControl = true;
  assert.throws(() => new MapRuntime(options()), /control setup/);
  assertReleased();
});

test('late map setup failure removes lifecycle listeners and cancels queued contributions', async t => {
  const { assertReleased } = environment(t);
  let loads = 0;
  assert.throws(() => new MapRuntime({ ...options(),
    contributions: [{ id: 'pending', async load() { loads++; return []; } }],
    onViewportChange() { throw new Error('viewport callback'); },
  }), /viewport callback/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loads, 0);
  assertReleased();
});

test('map teardown cancels contributions and continues through save and layer cleanup failures once', async t => {
  const { assertReleased } = environment(t);
  const errors = t.mock.method(console, 'error', () => {});
  let signal: AbortSignal | undefined, failSave = false;
  const runtime = new MapRuntime({ ...options(),
    contributions: [{ id: 'loaded', async load(context) { signal = context.signal; return []; } }],
    onViewChange() { if (failSave) throw new Error('save failure'); },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(signal?.aborted, false);
  const unmount = t.mock.method(MapLayerHost.prototype, 'unmount', () => { throw new Error('layer cleanup'); });
  FakeMap.instances.at(-1)!.zoom++;
  failSave = true;
  runtime.destroy(); runtime.destroy();
  assert.equal(signal?.aborted, true);
  assert.equal(unmount.mock.callCount(), 1);
  assert.equal(errors.mock.callCount(), 2);
  assertReleased();
});

for (const sourceId of ['zlayer-basemap', 'chart-@vfr-sectional', 'chart-@ifr-low', 'chart-@ifr-high'])
test(`${sourceId} recovery waits for its failed tiles, not map idle or other successful tiles`, t => {
  environment(t);
  const reported: Array<string | undefined> = [], recovered: string[] = [];
  const runtime = new MapRuntime({ ...options(), onError: (_message, _code, resource) => reported.push(resource),
    onErrorRecovered: resource => recovered.push(resource) });
  const map = FakeMap.instances.at(-1)!;
  const tiles = new Map<string, { state: string; uses: number; tileID: { key: string } }>();
  const tile = (key: string, state = 'loaded', source = sourceId) => {
    const identity = `${source}:${key}`;
    let tile = tiles.get(identity);
    if (!tile) tiles.set(identity, tile = { state, uses: 1, tileID: { key } });
    tile.state = state;
    return { sourceId: source, tile };
  };
  map.fire('error', { ...tile('a', 'errored'), error: new Error('Failed to fetch tile a') });
  map.fire('error', { ...tile('b', 'errored'), error: new Error('Failed to fetch tile b') });
  map.fire('idle');
  map.fire('sourcedata', { sourceId, isSourceLoaded: true });
  map.fire('sourcedata', tile('a', 'loaded', 'other-source'));
  map.fire('sourcedata', tile('c'));
  map.fire('sourcedata', tile('a', 'errored'));
  assert.deepEqual(recovered, []);
  map.fire('sourcedata', tile('a'));
  assert.deepEqual(recovered, [], 'one recovered tile cannot resolve another outstanding failure');
  tile('b', 'errored').tile.tileID = { key: 'wrapped-b' };
  map.fire('sourcedata', tile('b'));
  assert.deepEqual(reported, [sourceId, sourceId], 'tile messages share their source identity');
  assert.deepEqual(recovered, [sourceId], 'MapLibre changing a tile ID during a world wrap cannot strand recovery');
  map.fire('sourcedata', tile('b'));
  assert.equal(recovered.length, 1, 'recovery is reported once');
  map.fire('error', { ...tile('a', 'errored'), error: new Error('Failed to fetch tile a again') });
  map.fire('sourcedata', tile('a'));
  assert.deepEqual(recovered, [sourceId, sourceId], 'recurrence can recover independently');
  map.fire('error', { ...tile('a', 'errored'), error: new Error('Failed to fetch tile a') });
  map.fire('error', { ...tile('b', 'errored'), error: new Error('Failed to fetch tile b') });
  map.fire('sourcedataabort', tile('a', 'errored'));
  assert.equal(recovered.length, 2, 'leaving one failed tile does not resolve another');
  map.fire('sourcedata', tile('b'));
  assert.deepEqual(recovered, [sourceId, sourceId, sourceId], 'a discarded fallback tile cannot keep a recovered view in error');
  map.fire('error', { ...tile('a', 'errored'), error: new Error('Texture allocation failed') });
  map.fire('sourcedata', tile('a'));
  assert.equal(recovered.length, 3, 'a tile request recovery cannot resolve rendering errors');
  assert.equal(reported.at(-1), undefined, 'rendering errors do not share request identity');
  runtime.destroy();
});

test('real MapLibre source removal clears only its request condition before a same-ID replacement', t => {
  t.after(() => runtime.destroy());
  environment(t);
  const recovered: string[] = [];
  const runtime = new MapRuntime({ ...options(), onError() {}, onErrorRecovered: id => recovered.push(id) });
  const map = FakeMap.instances.at(-1)!;
  // Exercise the pinned library's actual removal/event ordering without WebGL.
  const managers: Record<string, Evented> = {};
  const style = Object.assign(Object.create(Style.prototype) as Style,
    { _loaded: true, _layers: {}, tileManagers: managers, _updatedSources: {}, map });
  t.mock.method(map, 'getSource', (id: string) => style.getSource(id));
  class SourceEvents extends Evented {}
  const parent = new SourceEvents();
  parent.on('data', event => map.fire('sourcedata', event));
  parent.on('dataabort', event => map.fire('sourcedataabort', event));
  const failure = (sourceId: string, key: string) => ({ sourceId,
    tile: { state: 'errored', uses: 1, tileID: { key } }, error: new Error('Failed to fetch') });
  const add = (id: string) => {
    const source = {};
    const manager = new SourceEvents();
    managers[id] = Object.assign(manager, { getSource: () => source,
      onRemove() { manager.fire('dataabort', failure(id, 'old')); } });
    manager.setEventedParent(parent);
  };
  for (const id of ['chart-@ifr-low', 'terrain']) { add(id); map.fire('error', failure(id, 'old')); }
  map.fire('sourcedata', { sourceDataType: 'metadata', sourceId: 'chart-@ifr-low' });
  assert.deepEqual(recovered, [], 'metadata for a live source cannot hide failed tiles');
  style.removeSource('chart-@ifr-low');
  assert.deepEqual(recovered, ['chart-@ifr-low']);
  add('chart-@ifr-low');
  const replacement = failure('chart-@ifr-low', 'replacement');
  map.fire('error', replacement);
  replacement.tile.state = 'loaded';
  map.fire('sourcedata', replacement);
  assert.deepEqual(recovered, ['chart-@ifr-low', 'chart-@ifr-low'], 'old failed tiles cannot strand replacement recovery');
  style.removeSource('terrain');
  assert.deepEqual(recovered, ['chart-@ifr-low', 'chart-@ifr-low', 'terrain']);
});

test('prolonged HTTP tile failures recover after panning, including cached refresh failures without abort events', t => {
  t.after(() => runtime.destroy());
  environment(t);
  const reported = new Set<string | undefined>(), recovered: string[] = [];
  const runtime = new MapRuntime({ ...options(), onError: (_message, _code, resource) => reported.add(resource),
    onErrorRecovered: id => recovered.push(id) });
  const map = FakeMap.instances.at(-1)!;
  for (let i = 0; i < 5000; i++) {
    const event = { sourceId: 'zlayer-basemap', tile: { state: 'errored', uses: 1, tileID: { key: String(i) } } };
    map.fire('error', { ...event, error: new Error(`AJAXError: Service Unavailable (503): https://tiles.test/${i}`) });
    event.tile.uses = 0;
    if (i % 2 === 0) map.fire('sourcedataabort', event);
  }
  assert.deepEqual([...reported], ['zlayer-basemap']);
  assert.deepEqual(recovered, [], 'panning during an outage does not reset dismissal');
  map.fire('sourcedata', { sourceId: 'zlayer-basemap', tile: { state: 'loaded', uses: 1, tileID: { key: 'healthy' } } });
  assert.deepEqual(recovered, ['zlayer-basemap']);
  map.fire('error', { sourceId: 'zlayer-basemap', error: new Error('Failed to fetch source metadata') });
  runtime.destroy();
  assert.deepEqual(recovered, ['zlayer-basemap', 'zlayer-basemap'], 'map teardown also retires source requests without a tile ID');
});

test('discarding failed tiles during an ongoing outage waits for successful data before recovery', t => {
  environment(t);
  const recovered: string[] = [];
  const runtime = new MapRuntime({ ...options(), onError() {}, onErrorRecovered: message => recovered.push(message) });
  const map = FakeMap.instances.at(-1)!;
  const event = { sourceId: 'chart-@ifr-low', tile: { state: 'errored', uses: 1, tileID: { key: 'old-view' } } };
  map.fire('error', { ...event, error: new Error('Failed to fetch') });
  map.fire('sourcedataabort', event);
  map.fire('sourcedata', { sourceId: event.sourceId, isSourceLoaded: true });
  assert.deepEqual(recovered, []);
  map.fire('sourcedata', { sourceId: event.sourceId, tile: { state: 'loaded', uses: 1, tileID: { key: 'new-view' } } });
  assert.equal(recovered.length, 1);
  runtime.destroy();
});
