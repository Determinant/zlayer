import assert from 'node:assert/strict';
import test from 'node:test';
import type { FeatureCollection } from 'geojson';
import type { Map as MapLibreMap, LayerSpecification } from 'maplibre-gl';
import type { GeoPointFeature } from '@zlayer/contracts';
import { nearbyVorStations } from '@zlayer/domain';
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
    const [from, to] = line.geometry.coordinates;
    assert.deepEqual(to, point.geometry.coordinates);
    assert.ok(Math.abs(from![0]! - to![0]!) < 1);
    assert.ok(Math.abs((from![0]! - stations[index]!.feature.geometry.coordinates[0]) % 360) < 1e-9);
  });
  assert.deepEqual(data.features.filter(feature => feature.properties?.ident).map(feature => feature.properties?.ident),
    stations.slice(0, 3).map(station => station.feature.properties.ident));
  assert.deepEqual(identificationGeoJson({ point, stations: [] }).features, []);
});

test('ID overlay survives remount and clears all map content on close or unavailable results', () => {
  const sources = new Map<string, FeatureCollection>();
  const layers = new Map<string, LayerSpecification>();
  const listeners = new Set<() => void>();
  const map = {
    getCenter() { return { lng: -180, lat: 0 }; },
    project([x, y]: [number, number]) { return { x, y: -y }; },
    unproject([x, y]: [number, number]) { return { toArray: () => [x, -y] }; },
    on(_event: string, listener: () => void) { listeners.add(listener); },
    off(_event: string, listener: () => void) { listeners.delete(listener); },
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
    assert.equal(listeners.size, 1);
    for (const listener of listeners) listener();
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
