import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { MapLayerHost } from '../src/core/map/layer';

class FakeMap {
  static instances: FakeMap[] = [];
  static failControl = false;
  touchZoomRotate = { _touchRotate: { _move() {} } };
  controls = 0;
  removals = 0;
  zoom = 9;
  constructor() { FakeMap.instances.push(this); }
  on() { return this; }
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
  onReady() {}, onViewportChange() {}, onError(message: string) { assert.fail(message); },
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
