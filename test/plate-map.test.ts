import assert from 'node:assert/strict';
import test from 'node:test';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { createPlatesController } from '../src/layers/plates/layer';
import type { ProcedureSelection } from '../src/layers/plates/data';
import type { PlateMapImage } from '../src/layers/plates/map-image';
import { createPlateMapLayer } from '../src/layers/plates/map';
import { PLATE_LAYER_ANCHOR } from '../src/core/map/layer';

const selection: ProcedureSelection = { airport: { id: 'KSBA' }, procedure: { id: 'first', name: 'First approach', kind: 'approach' },
  document: { url: 'https://test/plate.pdf', nativeUrl: 'https://test/plate.pdf', pageIndex: 0, source: 'faa-individual' },
  cycle: '2609', effectiveDate: '2026-09-03', expirationDate: '2026-10-01' };
function image(name: string): PlateMapImage {
  return { selection: { ...selection, procedure: { id: name, name, kind: 'approach' } },
    canvas: { width: 400, height: 600 } as HTMLCanvasElement,
    coordinates: [[-120, 35], [-119, 35], [-119, 34], [-120, 34]],
    outline: [[-120, 35], [-119, 35], [-119, 34], [-120, 34]] };
}

test('a single map plate survives viewer opens, replaces atomically and releases removed canvases', () => {
  const product = createPlatesController();
  const first = image('first'), second = image('second');
  product.open(first.selection);
  product.showOnMap(first, product.getSnapshot().requestId);
  assert.equal(product.getSnapshot().selection, undefined);
  assert.equal(product.getSnapshot().mapImage, first);
  product.open(second.selection);
  const request = product.getSnapshot().requestId;
  product.close(request);
  assert.equal(product.getSnapshot().mapImage, first);
  product.open(second.selection);
  const changes: string[] = [];
  product.subscribe(() => { changes.push(product.getSnapshot().mapImage?.selection.procedure.id ?? 'none'); });
  product.showOnMap(second, product.getSnapshot().requestId);
  assert.deepEqual(changes, ['second']);
  assert.equal(first.canvas.width, 0);
  product.hideFromMap(first);
  assert.equal(product.getSnapshot().mapImage, second, 'a stale close cannot remove the replacement');
  product.hideFromMap(second);
  assert.equal(product.getSnapshot().mapImage, undefined);
  assert.equal(second.canvas.height, 0);
});

test('a late render after closing or replacing its viewer cannot change the map', () => {
  const product = createPlatesController();
  product.open(selection);
  const request = product.getSnapshot().requestId;
  product.open({ ...selection, procedure: { id: 'next', name: 'Next' } });
  const late = image('late');
  product.showOnMap(late, request);
  assert.equal(product.getSnapshot().mapImage, undefined);
  assert.equal(product.getSnapshot().selection?.procedure.id, 'next');
  assert.equal(late.canvas.width, 0);
  product.close();
  product.showOnMap(image('closed'), product.getSnapshot().requestId);
  assert.equal(product.getSnapshot().mapImage, undefined);
});

test('actions captured for a previous overlay cannot hide its replacement', () => {
  const product = createPlatesController();
  const first = image('first'), second = image('second');
  product.open(first.selection);
  product.showOnMap(first, product.getSnapshot().requestId);
  product.open(second.selection);
  product.showOnMap(second, product.getSnapshot().requestId);
  product.hideFromMap(first);
  assert.equal(product.getSnapshot().mapImage, second);
});

test('map inspection identifies only the current footprint and restores after reattachment', () => {
  const product = createPlatesController();
  let layer = createPlateMapLayer(product);
  const sources = new Set<string>(), layers = new Set<string>();
  const handlers = new Map<string, () => void>();
  let fits = 0;
  const map = {
    on: (event: string, handler: () => void) => handlers.set(event, handler),
    off: (event: string) => handlers.delete(event),
    getSource: (id: string) => sources.has(id), getLayer: (id: string) => layers.has(id),
    addSource: (id: string) => { assert.equal(sources.size, 0); sources.add(id); },
    addLayer: ({ id }: { id: string }, anchor: string) => { assert.equal(anchor, PLATE_LAYER_ANCHOR); layers.add(id); },
    removeLayer: (id: string) => layers.delete(id),
    removeSource: (id: string) => { assert.equal(layers.size, 0); sources.delete(id); },
    fitBounds() { fits++; }, unproject: ([lng, lat]: number[]) => ({ lng, lat }),
  } as unknown as MapLibreMap;
  layer.mount(map);
  for (const name of ['first', 'second']) {
    const next = image(name);
    product.open(next.selection);
    product.showOnMap(next, product.getSnapshot().requestId);
    assert.equal(sources.size, 1);
    assert.equal(layers.size, 1);
  }
  layer.unmount();
  assert.equal(sources.size, 0);
  assert.ok(product.getSnapshot().mapImage!.canvas.width > 0);
  layer.mount(map);
  assert.equal(sources.size, 1);
  assert.equal(fits, 2, 'reattaching after a style change preserves the camera');
  layer.unmount();
  layer = createPlateMapLayer(product, product.getSnapshot().mapImage);
  layer.mount(map);
  assert.equal(fits, 2, 'a fresh attachment must not replay an old Show on map action');
  const third = image('third');
  product.open(third.selection);
  product.showOnMap(third, product.getSnapshot().requestId);
  assert.equal(fits, 3, 'a new explicit Show on map still fits after restoring an attachment');
  assert.equal(layer.imageAt({ x: -118, y: 34 }), undefined);
  assert.equal(sources.size, 1);
  const point = { x: -119.5, y: 34.5 };
  assert.equal(layer.imageAt(point), third);
  assert.equal(sources.size, 1, 'inspection preserves the overlay');
  assert.ok(product.getSnapshot().mapImage!.canvas.width > 0);
  layer.unmount();
  assert.equal(layer.imageAt(point), undefined);
  assert.equal(handlers.size, 0);
  layer.mount(map);
  assert.equal(layer.imageAt(point), third);
  product.hideFromMap(third);
  assert.equal(layer.imageAt(point), undefined);
  assert.equal(sources.size, 0);
  assert.equal(layers.size, 0);
  layer.unmount();
});
