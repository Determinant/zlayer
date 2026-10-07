import assert from 'node:assert/strict';
import test from 'node:test';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { createLayerStore } from '../src/core/layers/store';
import type { GpsSnapshot } from '../src/core/gps/service';
import { createOwnshipLayer } from '../src/layers/ownship/layer';
import { createOwnshipMapLayer } from '../src/layers/ownship/map';

function setup(t: test.TestContext) {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const context = new Proxy({}, { get: (_, key) => key === 'getImageData' ? () => ({}) : () => {} });
  for (const [key, value] of Object.entries({
    document: { createElement: () => ({ getContext: () => context }) },
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (original) Object.defineProperty(globalThis, key, original); else Reflect.deleteProperty(globalThis, key); });
  }
  const gps = createLayerStore<GpsSnapshot>({ state: 'off', fix: null });
  let leases = 0;
  const product = createOwnshipLayer({ ...gps, acquire: () => { leases++; return () => { leases--; }; }, retry() {} });
  const uploads: FeatureCollection[] = [], sources: FeatureCollection[] = [];
  const errors = new Set<(event: { sourceId: string; error: Error }) => void>();
  const visibility = new Map<string, string>();
  const source = {
    setData(data: FeatureCollection) { uploads.push(data); return Promise.resolve(); },

  };
  const map = {
    on(_type: string, fn: (event: { sourceId: string; error: Error }) => void) { errors.add(fn); },
    off(_type: string, fn: (event: { sourceId: string; error: Error }) => void) { errors.delete(fn); },
    setPaintProperty(id: string, _property: string, value: number) { visibility.set(id, value ? 'visible' : 'none'); },
    addImage() {}, addLayer() {}, removeLayer() {}, removeSource() {}, removeImage() {}, getLayer: () => true, hasImage: () => true,
    addSource(_id: string, options: { data: FeatureCollection }) { sources.push(options.data); },
    getSource: () => source,
  };
  const adapter = createOwnshipMapLayer(product);
  const mount = () => adapter.mount(map as unknown as MapLibreMap);
  mount(); t.after(() => adapter.unmount());
  let time = 0;
  const fix = (longitude = -122) => gps.publish({ state: 'tracking', fix: {
    coordinates: [longitude, 37], accuracy: 5, timestamp: ++time * 1000, time,
    track: 90, speed: 60, altitude: time, altitudeAccuracy: 5, estimated: false,
  } });
  const frame = async () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0); await Promise.resolve(); await Promise.resolve(); };
  return { visibility, source, gps, product, adapter, mount, map, leases: () => leases, sources, uploads, fix, frame, sourceError: () => { for (const fn of errors) fn({ sourceId: 'ownship', error: new Error('Source failed') }); },
    errorListeners: () => errors.size, pending: () => frames.size };
}

test('stationary fixes preserve freshness without rebuilding map geometry; disabled GPS is idle', async t => {
  const s = setup(t);
  for (let i = 0; i < 100; i++) s.fix();
  assert.equal(s.pending(), 0); assert.equal(s.uploads.length, 0);
  s.adapter.update({ enabled: true }); await s.frame();
  const baseline = s.uploads.length;
  for (let i = 0; i < 100; i++) { s.fix(); await s.frame(); }
  assert.equal(s.product.getSnapshot().fix, s.gps.getSnapshot().fix);
  assert.equal(s.uploads.length, baseline);
  s.product.center(); await s.frame();
  assert.equal(s.uploads.length, baseline, 'camera requests do not re-upload geometry');
  s.adapter.update({ enabled: false });
  assert.deepEqual(s.uploads.at(-1)!.features, []);
  for (let i = 0; i < 100; i++) { s.fix(); await s.frame(); }
  assert.equal(s.uploads.length, baseline + 1);
});

test('a map cleanup exception cannot retain GPS, pending frames or later resources', async t => {
  const s = setup(t); s.adapter.update({ enabled: true }); s.fix();
  assert.equal(s.leases(), 1);
  const removed: string[] = [];
  t.mock.method(console, 'error', () => {});
  t.mock.method(s.map, 'removeLayer', () => { throw new Error('Layer already unavailable'); });
  t.mock.method(s.map, 'removeSource', () => { removed.push('source'); });
  t.mock.method(s.map, 'removeImage', () => { removed.push('image'); });
  s.adapter.unmount();
  assert.equal(s.leases(), 0); assert.equal(s.pending(), 0); assert.equal(s.errorListeners(), 0);
  assert.deepEqual(removed, ['source', 'image']);
  s.adapter.unmount(); assert.deepEqual(removed, ['source', 'image'], 'cleanup is idempotent');
});

test('bursts upload the latest position once; stale state cancels queued live geometry; remount rebuilds once', async t => {
  const s = setup(t); s.adapter.update({ enabled: true });
  s.fix(-122); s.fix(-121); s.fix(-120);
  assert.equal(s.pending(), 1); assert.equal(s.uploads.length, 0);
  await s.frame();
  assert.equal(s.uploads.length, 1);
  assert.deepEqual(s.uploads[0]!.features[0]!.geometry, { type: 'Point', coordinates: [-120, 37] });
  s.fix(-119);
  s.gps.publish({ ...s.gps.getSnapshot(), state: 'stale' });
  assert.equal(s.pending(), 0);
  assert.equal(s.uploads.at(-1)!.features.some(feature => feature.properties?.kind === 'projection'), false);
  s.fix(-118); s.adapter.unmount();
  assert.equal(s.pending(), 0);
  const baseline = s.uploads.length;
  await s.frame(); assert.equal(s.uploads.length, baseline);
  s.mount(); await s.frame();
  assert.equal(s.sources.length, 2);
  assert.deepEqual(s.uploads.at(-1)!.features[0]!.geometry, { type: 'Point', coordinates: [-118, 37] });
});


test('a source failure retries once and unmount releases its listener', async t => {
  const s = setup(t); s.adapter.update({ enabled: true });
  assert.equal(s.errorListeners(), 1);
  s.fix(); await s.frame(); s.fix(); await s.frame(); s.fix(); await s.frame();
  const baseline = s.uploads.length;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  s.sourceError(); s.fix(); t.mock.timers.tick(100); await s.frame();
  assert.equal(s.uploads.length, baseline + 1);
  s.fix(); await s.frame();
  assert.equal(s.uploads.length, baseline + 1, 'successful retry restores visual deduplication');
  s.adapter.unmount();
  s.sourceError(); s.fix(); t.mock.timers.tick(100); await s.frame();
  assert.equal(s.errorListeners(), 0);
  assert.equal(s.pending(), 0);
  assert.equal(s.uploads.length, baseline + 1);
});

test('failed submissions hide live geometry and retry is bounded, including synchronous source errors', async t => {
  const s = setup(t); s.adapter.update({ enabled: true }); s.fix(); await s.frame();
  assert.equal(s.visibility.get('ownship-aircraft'), 'visible');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(s.source, 'setData', (data: FeatureCollection) => {
    s.uploads.push(data); s.sourceError(); return Promise.reject(new Error('Worker failed'));
  });
  s.gps.publish({ ...s.gps.getSnapshot(), state: 'stale' });
  assert.equal(s.visibility.get('ownship-aircraft'), 'none', 'hide before asynchronous acceptance');
  await s.frame();
  const count = s.uploads.length;
  t.mock.timers.tick(100); await s.frame();
  assert.equal(s.uploads.length, count + 1);
  t.mock.timers.tick(10_000); await s.frame();
  assert.equal(s.uploads.length, count + 1, 'permanent failure cannot create a retry loop');
  assert.ok([...s.visibility.values()].every(value => value === 'none'));
});

test('a late live acceptance cannot reveal stale or disabled ownship', async t => {
  const s = setup(t); s.adapter.update({ enabled: true });
  const completions: (() => void)[] = [];
  t.mock.method(s.source, 'setData', () => new Promise<void>(resolve => completions.push(resolve)));
  s.fix(); await s.frame();
  s.gps.publish({ ...s.gps.getSnapshot(), state: 'stale' });
  completions[0]!(); await s.frame();
  assert.ok([...s.visibility.values()].every(value => value === 'none'));
  s.adapter.update({ enabled: false });
  completions[1]!(); await s.frame();
  assert.ok([...s.visibility.values()].every(value => value === 'none'));
  s.adapter.unmount(); completions[2]!(); await s.frame();
  assert.equal(s.errorListeners(), 0);
});
