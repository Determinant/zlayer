import assert from 'node:assert/strict';
import test from 'node:test';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { SurfaceFrame } from '@zlayer/contracts';
import type { WeatherController } from '../src/layers/weather-awc/controller';
import { mountProgsMap } from '../src/layers/weather-awc/progs/map';

test('Progs disable releases map resources and late acceptance cannot reveal the old frame', async t => {
  const context = new Proxy({}, { get: () => () => {} });
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ getContext: () => context }) } });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'document', original); else Reflect.deleteProperty(globalThis, 'document'); });
  const sources = new Set<string>(), layers = new Set<string>(), images = new Set<string>();
  let accept!: () => void, shown = 0, enabled = true;
  const map = {
    on() {}, off() {},
    getSource: (id: string) => sources.has(id) ? { setData: () => new Promise<void>(resolve => { accept = resolve; }) } : undefined,
    getLayer: (id: string) => layers.has(id), hasImage: (id: string) => images.has(id),
    addSource: (id: string) => sources.add(id), addLayer: ({ id }: { id: string }) => layers.add(id), addImage: (id: string) => images.add(id),
    removeSource: (id: string) => sources.delete(id), removeLayer: (id: string) => layers.delete(id), removeImage: (id: string) => images.delete(id),
    setLayoutProperty(_id: string, _key: string, value: string) { if (value === 'visible') shown++; },
  } as unknown as MapLibreMap;
  const frame = { artifactHash: 'hash', validTime: 1, features: [] } as unknown as SurfaceFrame;
  const controller = { getSnapshot: () => ({ preferences: { awcEnabled: true, awcProgs: enabled, awcProgsIsobars: true }, progsRetry: 0 }),
    surfaceSelection: () => ({ product: 'analysis', frame }), setProgsRenderError() {} } as unknown as WeatherController;
  const adapter = mountProgsMap(map, controller, 'anchor');
  adapter.update(); assert.ok(sources.size && layers.size && images.size);
  enabled = false; adapter.update(); adapter.update();
  assert.equal(sources.size + layers.size + images.size, 0);
  accept(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(shown, 0); assert.equal(adapter.shown, undefined);
  enabled = true; adapter.update(); accept(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(adapter.shown, frame); assert.ok(shown > 0);
  adapter.destroy(); assert.equal(sources.size + layers.size + images.size, 0);
});
