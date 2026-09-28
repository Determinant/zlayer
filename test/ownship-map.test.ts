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
  const product = createOwnshipLayer({ ...gps, acquire: () => () => {}, retry() {} });
  const uploads: FeatureCollection[] = [], sources: FeatureCollection[] = [];
  const errors = new Set<() => void>();
  const source = {
    setData(data: FeatureCollection) { uploads.push(data); return Promise.resolve(); },
    on(_type: string, fn: () => void) { errors.add(fn); },
    off(_type: string, fn: () => void) { errors.delete(fn); },
  };
  const map = {
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
  const frame = () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0); };
  return { gps, product, adapter, mount, sources, uploads, fix, frame, sourceError: () => { for (const fn of errors) fn(); },
    errorListeners: () => errors.size, pending: () => frames.size };
}

test('stationary fixes preserve freshness without rebuilding map geometry; disabled GPS is idle', t => {
  const s = setup(t);
  for (let i = 0; i < 100; i++) s.fix();
  assert.equal(s.pending(), 0); assert.equal(s.uploads.length, 0);
  s.adapter.update({ enabled: true }); s.frame();
  const baseline = s.uploads.length;
  for (let i = 0; i < 100; i++) { s.fix(); s.frame(); }
  assert.equal(s.product.getSnapshot().fix, s.gps.getSnapshot().fix);
  assert.equal(s.uploads.length, baseline);
  s.product.center(); s.frame();
  assert.equal(s.uploads.length, baseline, 'camera requests do not re-upload geometry');
  s.adapter.update({ enabled: false });
  assert.deepEqual(s.uploads.at(-1)!.features, []);
  for (let i = 0; i < 100; i++) { s.fix(); s.frame(); }
  assert.equal(s.uploads.length, baseline + 1);
});

test('bursts upload the latest position once; stale state cancels queued live geometry; remount rebuilds once', t => {
  const s = setup(t); s.adapter.update({ enabled: true });
  s.fix(-122); s.fix(-121); s.fix(-120);
  assert.equal(s.pending(), 1); assert.equal(s.uploads.length, 0);
  s.frame();
  assert.equal(s.uploads.length, 1);
  assert.deepEqual(s.uploads[0]!.features[0]!.geometry, { type: 'Point', coordinates: [-120, 37] });
  s.fix(-119);
  s.gps.publish({ ...s.gps.getSnapshot(), state: 'stale' });
  assert.equal(s.pending(), 0);
  assert.equal(s.uploads.at(-1)!.features.some(feature => feature.properties?.kind === 'projection'), false);
  s.fix(-118); s.adapter.unmount();
  assert.equal(s.pending(), 0);
  const baseline = s.uploads.length;
  s.frame(); assert.equal(s.uploads.length, baseline);
  s.mount(); s.frame();
  assert.equal(s.sources.length, 2);
  assert.deepEqual(s.uploads.at(-1)!.features[0]!.geometry, { type: 'Point', coordinates: [-118, 37] });
});


test('a source failure lets the next fresh unchanged fix retry and unmount releases its listener', t => {
  const s = setup(t); s.adapter.update({ enabled: true });
  assert.equal(s.errorListeners(), 1);
  s.fix(); s.frame(); s.fix(); s.frame(); s.fix(); s.frame();
  const baseline = s.uploads.length;
  s.sourceError(); s.fix(); s.frame();
  assert.equal(s.uploads.length, baseline + 1);
  s.fix(); s.frame();
  assert.equal(s.uploads.length, baseline + 1, 'successful retry restores visual deduplication');
  s.adapter.unmount(); s.sourceError(); s.fix(); s.frame();
  assert.equal(s.errorListeners(), 0);
  assert.equal(s.pending(), 0);
  assert.equal(s.uploads.length, baseline + 1);
});
