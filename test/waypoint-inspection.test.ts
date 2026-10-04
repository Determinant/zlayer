import assert from 'node:assert/strict';
import test from 'node:test';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import type { GeoPointFeature } from '@zlayer/contracts';
import { createWaypointInspectionLayer } from '../src/layers/navigation/waypoint-inspection';

test('inspection keeps labels with coordinates and hides failed or pending clears', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const layers = new Map<string, { layout: Record<string, unknown> }>();
  const uploads: { data: FeatureCollection; accept: () => void }[] = [];
  const map = {
    addSource() {}, removeSource() {},
    addLayer(layer: { id: string; layout?: Record<string, unknown> }) { layers.set(layer.id, { layout: layer.layout ?? {} }); },
    getLayer: (id: string) => layers.get(id), removeLayer: (id: string) => layers.delete(id),
    getLayoutProperty: (id: string, key: string) => layers.get(id)?.layout[key],
    setLayoutProperty(id: string, key: string, value: unknown) { layers.get(id)!.layout[key] = value; },
    getSource: () => ({ setData: (data: FeatureCollection) => new Promise<void>(accept => uploads.push({ data, accept })) }),
    on(type: string, listener: (event: unknown) => void) { const set = listeners.get(type) ?? new Set(); set.add(listener); listeners.set(type, set); },
    off(type: string, listener: (event: unknown) => void) { listeners.get(type)?.delete(listener); },
  } as unknown as MapLibreMap;
  const selected = (ident: string, longitude: number): GeoPointFeature => ({ type: 'Feature',
    geometry: { type: 'Point', coordinates: [longitude, 37] }, properties: { ident, kind: 'waypoint' } });
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  const fail = () => listeners.get('error')?.forEach(listener => listener({ sourceId: 'waypoint-inspection', error: new Error('Source failed') }));
  const visibility = () => map.getLayoutProperty('waypoint-inspection-point', 'visibility');
  const layer = createWaypointInspectionLayer();
  layer.update(selected('FIRST', -122)); layer.mount(map); t.after(() => layer.unmount());
  uploads[0]!.accept(); await settle(); assert.equal(visibility(), 'visible');
  layer.update(selected('SECOND', -121));
  assert.deepEqual(uploads[1]!.data.features[0]!.geometry, { type: 'Point', coordinates: [-121, 37] });
  assert.equal(uploads[1]!.data.features[0]!.properties!.inspectionLabel, 'SECOND');
  assert.deepEqual(map.getLayoutProperty('waypoint-inspection-label', 'text-field'), ['get', 'inspectionLabel']);
  fail(); assert.equal(visibility(), 'none');
  uploads[1]!.accept(); await settle(); assert.equal(visibility(), 'none', 'obsolete completion cannot reveal failed geometry');
  t.mock.timers.tick(100); uploads[2]!.accept(); await settle(); assert.equal(visibility(), 'visible');
  layer.update(undefined); assert.equal(visibility(), 'none');
  fail(); t.mock.timers.tick(100);
  uploads[4]!.accept(); await settle(); assert.equal(visibility(), 'none', 'accepted empty retry stays hidden');
  layer.update(selected('LATE', -120));
  layer.unmount(); uploads[5]!.accept(); await settle();
  assert.equal(layers.size, 0);
  assert.ok([...listeners.values()].every(set => !set.size));
  t.mock.timers.tick(1000); assert.equal(uploads.length, 6);
});
