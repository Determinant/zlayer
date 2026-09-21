import assert from 'node:assert/strict';
import test from 'node:test';
import { LngLatBounds, type Map as MapLibreMap } from 'maplibre-gl';
import { featureFilter } from '@maplibre/maplibre-gl-style-spec';
import type { LayerSpecification } from 'maplibre-gl';
import type { FeatureCollectionResponse } from '@zlayer/contracts';
import { createRouteResolver, routeCoordinateFeature, routeDraftFromText, routeDraftText } from '@zlayer/domain';
import { insertRouteFeature } from '../src/layers/routes/draft';
import { createRouteRemovalResolver } from './helpers/route-removal';
import { unwrapRouteCoordinates } from '../src/layers/routes/geometry';
import { routeEditProperties, routeEditTarget } from '../src/layers/routes/editing';
import { installRouteLayers, syncRoute, ROUTE_SOURCE_ID, ROUTE_DRAG_SOURCE_ID, RECOMMENDATION_SOURCE_ID } from '../src/layers/routes/renderer';
import { routeSegments } from '../src/layers/terrain/geometry';
import type { FeatureCollection } from 'geojson';

const coordinates: [number, number][] = [[-176.64248222, 51.88358277], [174.11358888, 52.71225833]];

test('edit targets reject old plan revisions even when geometry and entry IDs are unchanged', () => {
  const resolve = createRouteResolver([airports]);
  const first = resolve('PADK PASY'), next = resolve('PADK PASY');
  const target = first.waypoints[0]!.edit!;
  const properties = routeEditProperties(target, first.revision);
  assert.deepEqual(routeEditTarget(properties, first), target);
  assert.equal(routeEditTarget(properties, next), undefined);
  assert.equal(routeEditTarget({ ...properties, editEntryId: 'missing' }, first), undefined);
});

for (const [route, from, to, expected] of [
  ['KSBA CMA ENTRY ARR1 KSMX', 'CMA', 'ENTRY', 'KSBA CMA 343000N1193000W ENTRY ARR1 KSMX'],
  ['KSBA DEP1 EXIT CMA KSMX', 'EXIT', 'CMA', 'KSBA DEP1 EXIT 343000N1193000W CMA KSMX'],
  ['KSBA CMA ENTRY V1 EXIT KSMX', 'CMA', 'ENTRY', 'KSBA CMA 343000N1193000W ENTRY V1 EXIT KSMX'],
  ['CMA KSBA TEST1 KSMX', 'CMA', 'KSBA', 'CMA 343000N1193000W KSBA TEST1 KSMX'],
] as const) test(`a connecting leg beside a published route keeps its insertion point: ${route}`, () => {
  const resolve = createRouteRemovalResolver(), draft = routeDraftFromText(route), plan = resolve(draft);
  const connector = plan.legs.find(leg => leg.from.ident === from && leg.to.ident === to)!;
  assert.ok(connector.edit);
  const waypoint = routeCoordinateFeature([-119.5, 34.5]);
  const next = insertRouteFeature(draft, connector.edit.afterEntryId, waypoint), updated = resolve(next);
  assert.equal(routeDraftText(next), expected);
  assert.ok(draft.entries.every(entry => next.entries.includes(entry)));
  assert.ok(updated.legs.some(leg => leg.from.ident === from && leg.to.ident === waypoint.properties.ident));
  assert.ok(updated.legs.some(leg => leg.from.ident === waypoint.properties.ident && leg.to.ident === to));
  const published = (route: typeof plan) => route.legs.filter(leg => leg.owners.length).map(leg => [leg.from.ident, leg.to.ident]);
  assert.deepEqual(published(updated), published(plan));
  assert.deepEqual(updated.unresolved, plan.unresolved);
  assert.ok(updated.legs.filter(leg => leg.owners.length).every(leg => !leg.edit));
});

test('procedure previews remain dashed in primary and alternative routes, without editable implicit legs', () => {
  const plan = createRouteResolver([airports])('PADK PASY');
  plan.legs[0]!.owners = [{ kind: 'procedure', ident: 'TEST', source: plan.waypoints[0]!.source }];
  delete plan.legs[0]!.edit;
  const layers: LayerSpecification[] = [];
  const sources = new Map<string, { features: Array<{ properties: Record<string, unknown> }> }>();
  const map = { addSource() {}, addImage() {}, setGlobalStateProperty() {}, addLayer: (layer: typeof layers[number]) => layers.push(layer),
    getSource: (id: string) => ({ setData: (value: NonNullable<ReturnType<typeof sources.get>>) => sources.set(id, value) }),
  } as unknown as MapLibreMap;
  installRouteLayers(map);
  syncRoute(map, plan);
  const leg = sources.get(ROUTE_SOURCE_ID)!.features.find(feature => feature.properties.routeKind === 'leg')!;
  assert.equal(leg.properties.procedurePreview, true);
  assert.equal('editEntryId' in leg.properties, false);
  const direct = createRouteResolver([airports])('PADK PASY');
  syncRoute(map, direct, undefined, { selectedKey: 'direct', routes: [{ key: 'direct', plan: direct }, { key: 'procedure', plan }] });
  const alternative = sources.get(RECOMMENDATION_SOURCE_ID)!.features[0]!;
  for (const id of ['route-procedure-line', 'route-alternative-procedure-line']) {
    const layer = layers.find(layer => layer.id === id);
    assert.ok(layer?.type === 'line');
    assert.deepEqual(layer.paint?.['line-dasharray'], [3, 2]);
    const filter = featureFilter(layer.filter, id).filter;
    assert.equal(filter({ zoom: 8 }, { type: 'LineString', properties: alternative.properties }), true);
    assert.equal(filter({ zoom: 8 }, { type: 'LineString', properties: { routeKind: 'leg' } }), false);
  }
  const solid = layers.find(layer => layer.id === 'route-alternative-line');
  assert.ok(solid?.type === 'line');
  assert.equal(featureFilter(solid.filter, solid.id).filter({ zoom: 8 }, { type: 'LineString', properties: alternative.properties }), false);
});
const airports: FeatureCollectionResponse = { type: 'FeatureCollection', features: coordinates.map((coordinate, i) => ({
  type: 'Feature', id: String(i), geometry: { type: 'Point', coordinates: coordinate },
  properties: { ident: i === 0 ? 'PADK' : 'PASY' },
})), meta: { layer: 'airports', revision: 'test', returned: 2, truncated: false } };

test('gap connections wrap the dateline, follow waypoint drags, and stay distinct in previews', () => {
  const resolve = createRouteResolver([airports]), plan = resolve('PADK UNKNOWN PASY');
  const layers: LayerSpecification[] = [], sources = new Map<string, FeatureCollection>();
  const map = { addSource() {}, addImage() {}, setGlobalStateProperty() {}, addLayer: (layer: LayerSpecification) => layers.push(layer),
    getSource: (id: string) => ({ setData: (data: FeatureCollection) => sources.set(id, data) }),
  } as unknown as MapLibreMap;
  installRouteLayers(map);
  const check = (source: string) => {
    const connection = sources.get(source)!.features.find(f => f.properties?.routeKind === 'planning-connection')!;
    assert.equal(connection.properties!.editKind, undefined);
    assert.equal(connection.geometry.type, 'LineString');
    if (connection.geometry.type !== 'LineString') throw new Error('Expected a connection');
    assert.ok(Math.abs(connection.geometry.coordinates[1]![0]! - connection.geometry.coordinates[0]![0]!) < 10);
    return { ...connection, geometry: connection.geometry };
  };
  syncRoute(map, plan);
  check(ROUTE_SOURCE_ID);
  const [segment] = routeSegments([plan]);
  assert.ok(Math.abs(segment![1][0] - segment![0][0]) < 10 / 360);
  syncRoute(map, plan, { target: plan.waypoints[0]!.edit!, revision: plan.revision, coordinate: [179, 52], snapped: false });
  assert.deepEqual(check(ROUTE_SOURCE_ID).geometry.coordinates[0], [179, 52]);
  const direct = resolve('PADK PASY');
  syncRoute(map, direct, undefined, { selectedKey: 'direct', routes: [{ key: 'direct', plan: direct }, { key: 'gap', plan }] });
  const feature = check(RECOMMENDATION_SOURCE_ID);
  for (const id of ['route-planning-connection', 'route-alternative-planning-connection', 'route-leg-hits', 'route-alternative-line']) {
    const layer = layers.find(l => l.id === id)!;
    assert.ok(layer.type === 'line');
    assert.equal(featureFilter(layer.filter, id).filter({ zoom: 8 }, { type: 'LineString', properties: feature.properties! }),
      id.endsWith('planning-connection'));
  }
});

test('dateline routes render and fit the short crossing, forward and reverse', () => {
  const resolve = createRouteResolver([airports]);
  for (const input of ['PADK PASY', 'PASY PADK']) {
    const plan = resolve(input);
    const sources = new Map<string, { features: Array<{ geometry: { type: string; coordinates: [number, number][] } }> }>();
    const map = { setGlobalStateProperty() {}, getSource: (id: string) => ({ setData: (data: NonNullable<ReturnType<typeof sources.get>>) => sources.set(id, data) }) };
    syncRoute(map as unknown as MapLibreMap, plan);
    const line = sources.get(ROUTE_SOURCE_ID)!.features.find(feature => feature.geometry.type === 'LineString')!.geometry.coordinates;
    assert.ok(Math.abs(line[1]![0] - line[0]![0]) < 10);
    assert.ok(plan.distanceNm > 340 && plan.distanceNm < 345);
    const fitted = unwrapRouteCoordinates(plan.waypoints.map(point => point.feature.geometry.coordinates), 180);
    const bounds = fitted.slice(1).reduce((box, coordinate) => box.extend(coordinate), new LngLatBounds(fitted[0], fitted[0]));
    assert.ok(bounds.getEast() - bounds.getWest() < 10);
    assert.ok(Math.abs(bounds.getCenter().lng - 180) < 5);
    syncRoute(map as unknown as MapLibreMap, plan, {
      target: plan.legs[0]!.edit!, revision: plan.revision, coordinate: [179, 52], snapped: false,
    });
    assert.equal(sources.get(ROUTE_SOURCE_ID)!.features.filter(feature => feature.geometry.type === 'LineString').length, 1,
      'the original remains available until preview tiles are ready and for immediate cancellation');
    const preview = sources.get(ROUTE_DRAG_SOURCE_ID)!.features[0]!.geometry.coordinates;
    assert.equal(preview.length, 3);
    assert.ok(preview.slice(1).every((point, i) => Math.abs(point[0] - preview[i]![0]) < 10));
  }
  assert.deepEqual(coordinates[0], [-176.64248222, 51.88358277], 'unwrapping must not mutate cached features');
});

test('recommendation previews preserve normal primary styling, use visible gray alternatives, and cannot edit the flight plan', () => {
  const resolve = createRouteResolver([airports]);
  const original = resolve('PADK');
  const first = resolve('PADK PASY');
  const second = resolve('PASY PADK');
  const sourceData = new Map<string, { features: Array<{ properties: Record<string, unknown>; geometry: { coordinates: unknown } }> }>();
  const layers: Array<{ id: string; paint?: Record<string, unknown> }> = [];
  const map = { addSource() {}, addImage() {}, setGlobalStateProperty() {}, addLayer: (layer: typeof layers[number]) => layers.push(layer),
    getSource: (id: string) => ({ setData: (data: Parameters<typeof sourceData.set>[1]) => sourceData.set(id, data) }),
  } as unknown as MapLibreMap;
  installRouteLayers(map);
  assert.equal(layers.find(layer => layer.id === 'route-line')!.paint!['line-color'], '#33c6ff');
  assert.equal(layers.find(layer => layer.id === 'route-alternative-line')!.paint!['line-color'], '#bac4ce');
  assert.ok(Number(layers.find(layer => layer.id === 'route-alternative-line')!.paint!['line-opacity']) >= 0.8);
  const preview = { routes: [{ key: 'first', plan: first }, { key: 'second', plan: second }], selectedKey: 'first' };
  syncRoute(map, original, undefined, preview);
  const primary = sourceData.get(ROUTE_SOURCE_ID)!;
  assert.equal(primary.features.filter(feature => feature.properties.routeKind === 'leg').length, first.legs.length);
  assert.equal(sourceData.get(RECOMMENDATION_SOURCE_ID)!.features.length, second.legs.length);
  for (const data of sourceData.values()) for (const feature of data.features) {
    assert.equal('editEntryId' in feature.properties, false);
    assert.equal('editKind' in feature.properties, false);
    assert.equal('planRevision' in feature.properties, false);
  }
  syncRoute(map, original, undefined, { ...preview, selectedKey: 'second' });
  assert.notDeepEqual(sourceData.get(ROUTE_SOURCE_ID)!.features[0]!.geometry.coordinates, primary.features[0]!.geometry.coordinates);
  syncRoute(map, original);
  assert.equal(sourceData.get(RECOMMENDATION_SOURCE_ID)!.features.length, 0, 'closing clears every alternative');
  assert.equal(sourceData.get(ROUTE_SOURCE_ID)!.features[0]!.properties.editEntryId, 'token:0', 'the original plan becomes editable again');
  assert.deepEqual(original.tokens, ['PADK'], 'previewing never mutates the actual flight plan');
});

for (const continuation of [false, true]) {
test(`resolved TEC paths preserve map editing outside the segment (continuation: ${continuation})`, () => {
  const navigation: FeatureCollectionResponse = { ...airports, features: airports.features.map(feature => ({ ...feature,
    properties: { ...feature.properties, faaId: feature.properties.ident!, icaoId: feature.properties.ident! },
  })) };
  const fixes: FeatureCollectionResponse = { ...airports, meta: { ...airports.meta, layer: 'fixes', returned: 1 },
    features: [{ ...airports.features[0]!, id: 'fix:MID', properties: { ident: 'MID' } }] };
  const plan = createRouteResolver([navigation, fixes], undefined, undefined, {
    type: 'ZLayerPreferredRoutes', metadata: { effectiveDate: '2026-09-03', source: 'test' }, routes: [{
      id: 'test', originId: 'PADK', destinationId: 'PASY', routeType: 'TEC', routeNumber: 1,
      designator: 'TEST1', route: 'MID', segments: [],
    }],
  })(`PADK TEST1 PASY${continuation ? ' PADK' : ''}`);
  let data: { features: Array<{ properties: Record<string, unknown> }> } | undefined;
  const map = { setGlobalStateProperty() {}, getSource: (id: string) => id === ROUTE_SOURCE_ID
    ? { setData: (value: typeof data) => { data = value; } } : undefined } as unknown as MapLibreMap;
  syncRoute(map, plan);
  const points = data!.features.filter(feature => feature.properties.routeKind === 'waypoint');
  assert.deepEqual(points.map(point => point.properties.editEntryId), continuation ? ['token:0', undefined, 'token:2', 'token:3'] : ['token:0', undefined, 'token:2']);
  const legs = data!.features.filter(feature => feature.properties.routeKind === 'leg');
  assert.equal(legs.length, continuation ? 3 : 2);
  assert.ok(legs.slice(0, 2).every(leg => !('editEntryId' in leg.properties)));
  if (continuation) assert.equal(legs[2]!.properties.editEntryId, 'token:2');
});
}
