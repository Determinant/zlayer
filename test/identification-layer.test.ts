import assert from 'node:assert/strict';
import test from 'node:test';
import type { FeatureCollection } from 'geojson';
import type { Map as MapLibreMap, LayerSpecification } from 'maplibre-gl';
import type { GeoPointFeature } from '@zlayer/contracts';
import { nearbyVorStations, radialReference } from '@zlayer/domain';
import { createNavaidIdentificationLayer, identificationGeoJson } from '../src/layers/navigation/identification-layer';

const point: GeoPointFeature = { type: 'Feature', properties: { kind: 'fix', ident: 'POINT' },
  geometry: { type: 'Point', coordinates: [-179.8, 0] } };
const stations = nearbyVorStations(point.geometry.coordinates, [179.8, -179.5, -179.2, -179].map((longitude, index) => ({
  type: 'Feature', id: `N${index}`, properties: { kind: 'navaid', ident: `N${index}`, type: 'VOR' },
  geometry: { type: 'Point', coordinates: [longitude, 0] },
})));

test('only the top three ranked stations connect to the target, with local dateline geometry', () => {
  const data = identificationGeoJson({ point, stations });
  const lines = data.features.filter(feature => feature.geometry.type === 'LineString');
  assert.equal(lines.length, 3);
  assert.equal(data.features.filter(feature => feature.properties?.target).length, 1);
  lines.forEach((line, index) => {
    if (line.geometry.type !== 'LineString') throw new Error('Expected line');
    const from = line.geometry.coordinates[0], to = line.geometry.coordinates.at(-1);
    assert.deepEqual(to, point.geometry.coordinates);
    assert.ok(Math.abs(from![0]! - to![0]!) < 1);
    assert.ok(Math.abs((from![0]! - stations[index]!.feature.geometry.coordinates[0]) % 360) < 1e-9);
  });
  assert.deepEqual(data.features.filter(feature => feature.properties?.ident).map(feature => feature.properties?.ident),
    stations.slice(0, 3).map(station => station.feature.properties.ident));
  assert.deepEqual(identificationGeoJson({ point, stations: [] }).features, []);
});

test('the selected radial is included beyond the top three, without duplicates, and keeps its saved station geometry', () => {
  const aligned = stations.map(station => ({ ...station, feature: { ...station.feature,
    properties: { ...station.feature.properties, stationDeclinationDeg: 12 } } }));
  const chosen = aligned[3]!;
  const radial = { reference: radialReference(chosen.feature)!, radial: 270, distanceNm: 48 };
  for (const nearby of [aligned, [chosen, ...aligned.slice(0, 3)], [], aligned.map(station => ({ ...station,
    feature: { ...station.feature, geometry: { type: 'Point' as const, coordinates: [0, 0] as [number, number] } } }))]) {
    const data = identificationGeoJson({ point, stations: nearby, radial });
    const lines = data.features.filter(feature => feature.geometry.type === 'LineString');
    assert.equal(lines.length, nearby.length ? nearby[0] === chosen ? 3 : 4 : 1);
    const selected = lines.filter(feature => feature.properties?.selected);
    assert.equal(selected.length, 1);
    assert.ok(selected[0]!.geometry.type === 'LineString');
    assert.deepEqual(selected[0]!.geometry.coordinates[0], chosen.feature.geometry.coordinates);
    assert.deepEqual(selected[0]!.geometry.coordinates.at(-1), point.geometry.coordinates);
    assert.equal(selected[0]!.properties?.reference, 'MB 270° · 48.0 NM');
    assert.equal(data.features.filter(feature => feature.properties?.selected).length, 4, 'line, reading, station and target are highlighted');
  }
  assert.ok(identificationGeoJson({ point, stations: aligned }).features.every(feature => !feature.properties?.selected),
    'returning to name/GPS removes the selected highlight');
  const external = identificationGeoJson({ point, stations: [], radial: { ...radial,
    reference: { ...radial.reference, id: 'fix:OTHER', ident: 'OTHER' } } });
  assert.deepEqual(external.features.find(feature => feature.properties?.ident === 'OTHER')?.geometry,
    { type: 'Point', coordinates: chosen.feature.geometry.coordinates }, 'rendering does not require a recommended VOR identity');
});

test('ID overlay survives remount and clears all map content on close or unavailable results', () => {
  const sources = new Map<string, FeatureCollection>();
  const layers = new Map<string, LayerSpecification>();
  const listeners = new Map<string, () => void>();
  const map = {
    getCenter() { return { lng: -180, lat: 0 }; },
    project([x, y]: [number, number]) { return { x, y: -y }; },
    unproject([x, y]: [number, number]) { return { toArray: () => [x, -y] }; },
    on(event: string, listener: () => void) { listeners.set(event, listener); },
    off(event: string) { listeners.delete(event); },
    addSource(id: string, source: { data: FeatureCollection }) { sources.set(id, source.data); },
    getSource(id: string) { return sources.has(id) ? { setData(data: FeatureCollection) { sources.set(id, data); } } : undefined; },
    removeSource(id: string) { sources.delete(id); },
    addLayer(layer: LayerSpecification) { layers.set(layer.id, layer); },
    getLayer(id: string) { return layers.get(id); },
    removeLayer(id: string) { layers.delete(id); },
  } as unknown as MapLibreMap;
  const layer = createNavaidIdentificationLayer();
  layer.update({ point, stations });
  for (let attempt = 0; attempt < 2; attempt++) {
    layer.mount(map);
    assert.equal(sources.get('navaid-identification')!.features.length, 10);
    assert.equal(layers.size, 5);
    const lines = layers.get('navaid-id-lines');
    assert.equal(lines?.type, 'line');
    assert.deepEqual(lines?.type === 'line' && lines.paint?.['line-dasharray'], [4, 2]);
    assert.equal(layer.interactiveLayerIds?.length ?? 0, 0);
    assert.equal(listeners.size, 2);
    listeners.get('move')!();
    layer.unmount();
    assert.equal(layers.size + sources.size + listeners.size, 0);
  }
  layer.mount(map);
  layer.update(undefined);
  assert.deepEqual(sources.get('navaid-identification')!.features, []);
  layer.update({ point, stations: [] });
  assert.deepEqual(sources.get('navaid-identification')!.features, []);
  layer.unmount();
});

test('connection labels show only MB and distance, including north rounding and missing alignment', () => {
  const references = [
    { ...stations[0]!, radial: 359.6, trueBearing: 15, distanceNm: 12.34 },
    { ...stations[1]!, radial: null, trueBearing: 0, distanceNm: 24.06 },
    { ...stations[2]!, radial: null, trueBearing: null, distanceNm: 30 },
  ];
  const data = identificationGeoJson({ point, stations: references });
  assert.deepEqual(data.features.filter(feature => feature.geometry.type === 'LineString')
    .map(feature => feature.properties?.reference), [
      'MB 360° · 12.3 NM', 'MB - · 24.1 NM', 'MB - · 30.0 NM',
    ]);
  assert.ok(data.features.every(feature => feature.properties?.trueReference === undefined));
});

test('identification skips unchanged camera geometry and coalesces pending submissions to the latest view', async () => {
  let move!: () => void, bearing = 0;
  const writes: FeatureCollection[] = [], finish: (() => void)[] = [];
  const sources = new Set<string>(), layers = new Set<string>();
  const map = {
    getCenter: () => ({ lng: -180, lat: 0 }),
    project: ([x, y]: number[]) => ({ x: x! * Math.cos(bearing) - y! * Math.sin(bearing), y: x! * Math.sin(bearing) + y! * Math.cos(bearing) }),
    unproject: ([x, y]: number[]) => ({ toArray: () => [x! * Math.cos(bearing) + y! * Math.sin(bearing), -x! * Math.sin(bearing) + y! * Math.cos(bearing)] }),
    on: (event: string, listener: () => void) => { if (event === 'move') move = listener; }, off() {},
    addSource: (id: string) => { sources.add(id); },
    getSource: () => ({ setData(data: FeatureCollection) { writes.push(data); return new Promise<void>(resolve => finish.push(resolve)); } }),
    removeSource: (id: string) => { sources.delete(id); },
    addLayer: (layer: { id: string }) => { layers.add(layer.id); }, getLayer: (id: string) => layers.has(id),
    removeLayer: (id: string) => { layers.delete(id); },
  } as unknown as MapLibreMap;
  const layer = createNavaidIdentificationLayer();
  layer.update({ point, stations }); layer.mount(map);
  for (let i = 0; i < 120; i++) move();
  assert.equal(writes.length, 0, 'unchanged projection submits nothing');
  bearing = 0.1; move();
  for (let i = 0; i < 120; i++) { bearing += 0.001; move(); }
  assert.equal(writes.length, 1, 'only one source update is in flight');
  finish.shift()!(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1], identificationGeoJson({ point, stations }, map), 'the successor uses the final camera');
  layer.unmount(); finish.shift()!(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 2, 'late completion cannot revive an unmounted overlay');
});

for (const stage of ['initial load', 'submission']) test(`identification retries unchanged geometry after a source error during ${stage}`, async t => {
  const listeners = new Map<string, (event?: { sourceId: string; error: Error }) => void>();
  const writes: FeatureCollection[] = [], finish: (() => void)[] = [];
  const sources = new Set<string>(), layers = new Set<string>();
  const map = {
    getCenter: () => ({ lng: -180, lat: 0 }),
    project: ([x, y]: number[]) => ({ x, y }),
    unproject: ([x, y]: number[]) => ({ toArray: () => [x, y] }),
    on: (event: string, listener: (event?: { sourceId: string; error: Error }) => void) => { listeners.set(event, listener); },
    off: (event: string) => { listeners.delete(event); },
    addSource: (id: string) => { sources.add(id); },
    getSource: () => ({ setData(data: FeatureCollection) {
      writes.push(data); return new Promise<void>(resolve => finish.push(resolve));
    } }),
    removeSource: (id: string) => { sources.delete(id); },
    addLayer: (layer: { id: string }) => { layers.add(layer.id); }, getLayer: (id: string) => layers.has(id),
    removeLayer: (id: string) => { layers.delete(id); },
  } as unknown as MapLibreMap;
  const layer = createNavaidIdentificationLayer(), selection = { point, stations };
  t.after(() => layer.unmount());
  if (stage === 'initial load') layer.update(selection);
  layer.mount(map);
  if (stage === 'submission') layer.update(selection);
  const before = writes.length;
  const fail = (sourceId: string) => listeners.get('error')!({ sourceId, error: new Error('Worker failed') });
  const settle = async () => { finish.shift()?.(); await new Promise(resolve => setImmediate(resolve)); };
  fail('unrelated-source'); layer.update(selection);
  assert.equal(writes.length, before, 'unrelated errors cannot invalidate this source');
  fail('navaid-identification');
  await settle(); // MapLibre resolves setData even when the worker reports an error.
  assert.equal(writes.length, before, 'failure alone must not start a retry loop');
  layer.update(selection);
  assert.equal(writes.length, before + 1, 'the same input retries failed geometry');
  assert.deepEqual(writes.at(-1), identificationGeoJson(selection, map));
  await settle();
  layer.update(selection);
  assert.equal(writes.length, before + 1, 'successful retry restores visual reuse');
  fail('navaid-identification');
  listeners.get('move')!();
  assert.equal(writes.length, before + 2, 'camera updates also retry unchanged geometry');
  fail('navaid-identification');
  listeners.get('move')!(); listeners.get('move')!();
  assert.equal(writes.length, before + 2, 'failure cannot release a still-pending submission');
  layer.unmount(); await settle();
  assert.equal(listeners.size + sources.size + layers.size, 0);
  assert.equal(writes.length, before + 2, 'late completion cannot revive the unmounted overlay');
});
