import assert from 'node:assert/strict';
import test from 'node:test';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { createPlatesController } from '../src/layers/plates/layer';
import { createPlateMapLayer } from '../src/layers/plates/map';
import type { ProcedureSelection } from '../src/layers/plates/data';
import type { PlateMapImage } from '../src/layers/plates/map-image';

const selection: ProcedureSelection = { airport: { id: 'KSBA' }, procedure: { id: 'iap', name: 'Approach', kind: 'approach' },
  document: { url: 'https://test/book.pdf?sha256=edition', nativeUrl: 'https://test/book.pdf#page=2',
    pageIndex: 1, pageCount: 2, source: 'combined-volume', sha256: 'a'.repeat(64), byteLength: 1024 },
  cycle: '2609', effectiveDate: '2026-09-03', expirationDate: '2026-10-01' };
const image = (source = selection): PlateMapImage => ({ selection: source,
  canvas: { width: 400, height: 600 } as HTMLCanvasElement,
  coordinates: [[-120, 35], [-119, 35], [-119, 34], [-120, 34]],
  outline: [[-120, 35], [-119, 35], [-119, 34], [-120, 34]] });
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

function storage(t: test.TestContext) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const records = new Map<string, string>();
  const localStorage = { getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => { records.set(key, value); } };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage } });
  t.after(() => original ? Object.defineProperty(globalThis, 'window', original) : Reflect.deleteProperty(globalThis, 'window'));
  return { records, localStorage, seed: () => records.set('zlayer-plugin:plates:plate-on-map', JSON.stringify({ version: 1, value: selection })) };
}

test('map plate stores only its source identity, restores independently of the viewer, and explicit hide persists', async t => {
  const { records } = storage(t);
  const first = createPlatesController(true);
  first.open(selection);
  first.showOnMap(image(), first.getSnapshot().requestId);
  const record = JSON.parse(records.get('zlayer-plugin:plates:plate-on-map')!);
  assert.deepEqual(record, { version: 1, value: selection }, 'no canvas, geometry, loading state or menu is serialized');
  const viewer = { ...selection, procedure: { ...selection.procedure, id: 'other', name: 'Other' } };
  first.open(viewer);
  const restored = createPlatesController(true);
  assert.deepEqual(restored.getSnapshot().selection, viewer);
  assert.deepEqual(restored.getSnapshot().mapSelection, selection);
  let rebuilt: PlateMapImage;
  const stop = restored.restoreOnMap(async source => { rebuilt = image(source); return rebuilt; });
  await settle();
  assert.equal(restored.getSnapshot().mapImage, rebuilt!);
  assert.equal(restored.getSnapshot().mapImageRestored, true);
  assert.deepEqual(restored.getSnapshot().selection, viewer, 'restoration never dismisses the reader');
  stop();
  restored.hideFromMap();
  assert.equal(rebuilt!.canvas.width, 0);
  assert.equal(createPlatesController(true).getSnapshot().mapSelection, undefined);
  assert.deepEqual(createPlatesController(true).getSnapshot().selection, viewer);
});

for (const action of ['hide', 'replace', 'unmount', 'unload'] as const) {
  test(`a late restoration cannot undo ${action} and frees its canvas`, async t => {
    const { seed } = storage(t); seed();
    const product = createPlatesController(true);
    let finish!: (value: PlateMapImage) => void;
    let signal!: AbortSignal;
    const stop = product.restoreOnMap((_source, cancellation) => {
      signal = cancellation;
      return new Promise(resolve => { finish = resolve; });
    });
    const replacement = image({ ...selection, procedure: { ...selection.procedure, id: 'new' } });
    if (action === 'hide') product.hideFromMap();
    if (action === 'unmount') stop();
    if (action === 'unload') product.dispose();
    if (action === 'replace') {
      product.open(replacement.selection);
      product.showOnMap(replacement, product.getSnapshot().requestId);
    }
    assert.equal(signal.aborted, true);
    const late = image(); finish(late);
    await settle();
    assert.equal(late.canvas.width, 0);
    assert.equal(product.getSnapshot().mapImage, action === 'replace' ? replacement : undefined);
    assert.equal(product.getSnapshot().mapRestoreError, undefined);
  });
}

test('plugin unload frees the map canvas and preserves reader and overlay intent for reload', async t => {
  const { records } = storage(t);
  const product = createPlatesController(true);
  product.open(selection);
  const first = image();
  product.showOnMap(first, product.getSnapshot().requestId);
  product.open(selection);
  const saved = [...records];
  const staleRequest = product.getSnapshot().requestId;
  product.dispose();
  assert.equal(first.canvas.width, 0);
  assert.deepEqual([...records], saved);
  assert.deepEqual(product.getSnapshot().selection, selection);
  assert.deepEqual(product.getSnapshot().mapSelection, selection);
  const late = image();
  product.showOnMap(late, staleRequest);
  assert.equal(late.canvas.width, 0);
  product.restoreOnMap(async () => image());
  await settle();
  assert.equal(product.getSnapshot().mapImage?.canvas.width, 400);
  assert.equal(product.getSnapshot().mapImageRestored, true);
  product.dispose();
});

test('failed restore retains the exact source for retry and does not change the camera when recovered', async t => {
  const { seed, records } = storage(t); seed();
  const product = createPlatesController(true);
  product.restoreOnMap(async () => { throw new Error('Offline'); });
  await settle();
  assert.equal(product.getSnapshot().mapRestoreError, 'Offline');
  assert.deepEqual(JSON.parse(records.get('zlayer-plugin:plates:plate-on-map')!).value, selection);
  product.retryMapRestore();
  assert.equal(product.getSnapshot().mapRestoreError, undefined);
  product.restoreOnMap(async source => image(source));
  await settle();
  let fits = 0, sources = 0;
  const map = { on() {}, off() {}, getSource: () => false, getLayer: () => false,
    addSource: () => sources++, addLayer() {}, fitBounds: () => fits++ } as unknown as MapLibreMap;
  const layer = createPlateMapLayer(product);
  layer.mount(map);
  assert.equal(sources, 1);
  assert.equal(fits, 0, 'restoring the overlay respects the saved camera');
  const replacement = image();
  product.open(selection);
  product.showOnMap(replacement, product.getSnapshot().requestId);
  assert.equal(fits, 1, 'an explicit Show on map still fits the approach');
  layer.unmount();
});

test('invalid map records fall back without overwriting storage and denied writes leave the session usable', t => {
  const { records, localStorage } = storage(t);
  for (const value of ['{broken', JSON.stringify({ version: 2, value: selection }),
    JSON.stringify({ version: 1, value: { ...selection, procedure: { ...selection.procedure, kind: 'airport-diagram' } } }),
    JSON.stringify({ version: 1, value: { ...selection, document: { ...selection.document, pageIndex: -1 } } })]) {
    records.set('zlayer-plugin:plates:plate-on-map', value);
    assert.equal(createPlatesController(true).getSnapshot().mapSelection, undefined);
    assert.equal(records.get('zlayer-plugin:plates:plate-on-map'), value);
  }
  localStorage.setItem = () => { throw new Error('Quota'); };
  const product = createPlatesController(true);
  product.open(selection);
  const next = image();
  product.showOnMap(next, product.getSnapshot().requestId);
  assert.equal(product.getSnapshot().mapImage, next);
  product.hideFromMap();
  assert.equal(product.getSnapshot().mapImage, undefined);
});
