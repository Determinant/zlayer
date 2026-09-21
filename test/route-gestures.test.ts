import assert from 'node:assert/strict';
import test from 'node:test';
import type { Map as MapLibreMap, MapGeoJSONFeature } from 'maplibre-gl';
import type { FeatureCollectionResponse, GeoPointFeature } from '@zlayer/contracts';
import { createRouteResolver, parseRouteCoordinate, type RoutePlan } from '@zlayer/domain';
import { MapGestures } from '../src/workspace/map/gestures';
import { ROUTE_LEG_HIT_LAYER_ID, ROUTE_WAYPOINT_HIT_LAYER_ID, ROUTE_SOURCE_ID, syncRoute, type RouteDragPreview } from '../src/layers/routes/renderer';
import { createRouteLayer } from '../src/layers/routes/layer';
import { routeEditProperties } from '../src/layers/routes/editing';
import type { NearbyFeature } from '../src/workspace/feature-selection';
import { withMapLabelKeys } from '../src/core/map/label';
import { resolveNavigationFeature } from '../src/layers/navigation/feature-details';

const navigation: FeatureCollectionResponse = { type: 'FeatureCollection',
  meta: { layer: 'fixes', revision: 'test', returned: 4, truncated: false },
  features: ['KSFO', 'SNS', 'KSJC', 'OAK'].map((ident, index) => ({ type: 'Feature', id: ident,
    properties: { ident }, geometry: { type: 'Point', coordinates: [-122 + index, 37] } })),
};
const resolve = createRouteResolver([navigation]);

function setup(t: test.TestContext, navigationFeatures: MapGeoJSONFeature[] = [], kind: 'waypoint' | 'leg' = 'waypoint',
  references: FeatureCollectionResponse = navigation) {
  const original = globalThis.window;
  const target = Object.assign(new EventTarget(), { setTimeout, clearTimeout });
  globalThis.window = target as unknown as Window & typeof globalThis;
  const handlers = new Map<string, (event: unknown) => void>();
  let route = resolve('KSFO SNS KSJC');
  let rendered = route;
  const control = () => ({ enabled: true, isEnabled() { return this.enabled; },
    enable() { this.enabled = true; }, disable() { this.enabled = false; } });
  const map = {
    on: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler),
    off: (name: string) => handlers.delete(name),
    getLayer: () => true,
    getCenter: () => ({ lng: -122 }),
    unproject: (_point: unknown) => ({ lng: -122 }),
    project: (_coordinate: [number, number]) => ({ x: 1000, y: 1000 }),
    queryRenderedFeatures: (_point: unknown, { layers }: { layers: string[] }) =>
      layers.includes(ROUTE_WAYPOINT_HIT_LAYER_ID)
        ? [{ layer: { id: kind === 'leg' ? ROUTE_LEG_HIT_LAYER_ID : ROUTE_WAYPOINT_HIT_LAYER_ID },
          properties: routeEditProperties(kind === 'leg' ? rendered.legs[0]!.edit! : rendered.waypoints[1]!.edit!, rendered.revision) }] : navigationFeatures,
    dragPan: control(), touchZoomRotate: control(), getCanvas: () => ({ style: {} }),
  };
  const edits: string[] = [];
  const selections: Array<GeoPointFeature | undefined> = [];
  const nearby: NearbyFeature[][] = [];
  const replacements: Array<{ index: string; feature: GeoPointFeature }> = [];
  const insertions: Array<{ afterEntryId: string; feature: GeoPointFeature }> = [];
  const previews: Array<RouteDragPreview | undefined> = [];
  const resolutions: GeoPointFeature[] = [];
  let editable = true;
  const gestures = new MapGestures(map as unknown as MapLibreMap, {
    route: () => route, interactiveLayerIds: () => [], preview: input => previews.push(input.preview),
    resolveFeature: feature => {
      resolutions.push(feature);
      return resolveNavigationFeature(feature, { fixes: references });
    },
    canEditRoute: () => editable,
    onSelect: feature => selections.push(feature), onRouteLegInsert: (afterEntryId, feature) => {
      assert.equal(kind, 'leg', 'unexpected insertion');
      insertions.push({ afterEntryId, feature });
    },
    onChooseNearby: features => nearby.push(features),
    onRouteWaypointReplace: (index, feature) => {
      assert.ok(navigationFeatures.length || feature.properties.kind === 'coordinate', 'unexpected replacement');
      replacements.push({ index, feature });
    },
    onRouteWaypointRemove: index => edits.push(index),
  });
  t.after(() => { gestures.destroy(); globalThis.window = original; });
  const touch = (name: string, count: number, x = 100, coordinate = [-122.5, 37.25]) => handlers.get(name)!({
    point: { x, y: 100 },
    // Match MapLibre: touchend exposes the lifted finger in points, even when
    // originalEvent.touches is empty. A zero-point stub would hide regressions.
    points: Array.from({ length: name === 'touchend' ? 1 : count }, () => ({ x, y: 100 })),
    originalEvent: { touches: Array.from({ length: count }, () => ({})) },
    lngLat: { lng: coordinate[0], lat: coordinate[1] }, preventDefault() {},
  });
  return { touch, edits, gestures, map, target, selections, replacements, handlers,
    nearby, insertions, previews, resolutions,
    setRoute: (next: RoutePlan, render = true) => { route = next; if (render) rendered = next; },
    setEditable: (value: boolean) => { editable = value; },
    click: () => handlers.get('click')!({ point: { x: 100, y: 100 } }),
  };
}

test('an unsnapped leg drop inserts the previewed GPS waypoint once and suppresses the following click', t => {
  const { touch, insertions, previews, target, click, selections } = setup(t, [], 'leg');
  touch('touchstart', 1);
  touch('touchmove', 1, 150);
  assert.equal(previews.at(-1)?.snapped, false);
  assert.deepEqual(previews.at(-1)?.coordinate, [-122.5, 37.25]);
  touch('touchend', 0);
  target.dispatchEvent(new Event('touchend'));
  assert.equal(insertions.length, 1);
  assert.equal(insertions[0]!.afterEntryId, 'token:0');
  assert.equal(insertions[0]!.feature.properties.ident, '371500N1223000W');
  assert.deepEqual(insertions[0]!.feature.geometry.coordinates, [-122.5, 37.25]);
  assert.equal(previews.at(-1), undefined);
  click();
  assert.deepEqual(selections, []);
});

test('leg snapping takes precedence and leaving a snap creates a coordinate at the latest position', t => {
  const feature = { ...navigation.features[3]!, layer: { id: 'fixes' } } as unknown as MapGeoJSONFeature;
  const features = [feature];
  const { touch, insertions, previews } = setup(t, features, 'leg');
  touch('touchstart', 1);
  touch('touchmove', 1, 150);
  assert.equal(previews.at(-1)?.snapped, true);
  touch('touchend', 0);
  assert.equal(insertions[0]!.feature.id, 'OAK');
  touch('touchstart', 1);
  touch('touchmove', 1, 150);
  features.length = 0;
  touch('touchmove', 1, 160, [-121, 36]);
  touch('touchend', 0);
  assert.equal(insertions[1]!.feature.properties.ident, '360000N1210000W');
});

for (const longitude of [180.01, -180.01, 540.01, -540.01]) {
  test(`snapping ranks candidates in the pointer's world copy at ${longitude} degrees`, t => {
    const nearestLongitude = longitude > 0 ? -179.99 : 179.99;
    const features = [nearestLongitude, nearestLongitude + Math.sign(longitude) * 0.01].map((lng, index) => ({
      type: 'Feature', id: `snap:${index}`, geometry: { type: 'Point', coordinates: [lng, 35] },
      properties: { ident: `POINT${index}` },
    })) as unknown as MapGeoJSONFeature[];
    const { map, touch, replacements, previews } = setup(t, features);
    // Like MapLibre, project does not implicitly move a canonical longitude into the visible copy.
    map.project = ([lng]) => ({ x: 150 + (lng - longitude) * 1000, y: 100 });
    touch('touchstart', 1);
    touch('touchmove', 1, 150, [longitude, 35]);
    assert.deepEqual(previews.at(-1)?.coordinate, [nearestLongitude, 35]);
    touch('touchend', 0);
    assert.equal(replacements[0]?.feature.id, 'snap:0');
  });
}

test('nearby planned points use the pointer world copy even when it differs from the map center', t => {
  const { handlers, nearby, map, setRoute } = setup(t);
  setRoute(resolve('350000N1795900W'));
  const longitude = 180 + 1 / 60;
  map.unproject = () => ({ lng: longitude });
  map.project = ([lng]) => ({ x: 100 + (lng - longitude) * 1000, y: 100 });
  handlers.get('contextmenu')!({ point: { x: 100, y: 100 }, preventDefault() {} });
  assert.equal(nearby[0]?.[0]?.feature.properties.ident, '350000N1795900W');
  assert.equal(nearby[0]?.[0]?.routePointId, 'token:0');
});

for (const action of ['click', 'nearby', 'snap'] as const) {
  test(`${action} restores precise GPS coordinates from rounded tile geometry`, t => {
    const feature = parseRouteCoordinate('350000N1190535W')!;
    // This point's coordinates after GeoJSON tile quantization at zoom 3.
    const coordinates = [-119.091796875, 34.99850370014629];
    const rendered = { ...feature, id: 0, source: ROUTE_SOURCE_ID,
      geometry: { type: 'Point', coordinates }, properties: { ...feature.properties,
        routeKind: 'waypoint', routePointId: 'gps', editEntryId: 'gps', planRevision: 1 },
    } as unknown as MapGeoJSONFeature & { geometry: GeoPointFeature['geometry'] };
    const { click, handlers, touch, selections, replacements } = setup(t, [rendered]);
    if (action === 'click') click();
    else if (action === 'nearby') handlers.get('contextmenu')!({ point: { x: 100, y: 100 }, preventDefault() {} });
    else {
      touch('touchstart', 1);
      touch('touchmove', 1, 150);
      touch('touchend', 0);
    }
    assert.deepEqual(action === 'snap' ? replacements[0]?.feature : selections[0], feature);
    assert.deepEqual(rendered.geometry.coordinates, coordinates);
  });
}

for (const distance of [10, 50]) {
  test(`a GPS waypoint drag moves the existing entry at ${distance}px without removing it`, t => {
    const { touch, replacements, insertions, edits, previews, setRoute } = setup(t);
    setRoute(resolve('KSFO 371500N1223000W KSJC'));
    touch('touchstart', 1);
    touch('touchmove', 1, 100 + distance, [-122.75, 37.5]);
    assert.equal(previews.at(-1)?.snapped, false);
    assert.deepEqual(previews.at(-1)?.coordinate, [-122.75, 37.5]);
    touch('touchend', 0);
    assert.equal(replacements.length, 1);
    assert.equal(replacements[0]!.index, 'token:1');
    assert.equal(replacements[0]!.feature.properties.ident, '373000N1224500W');
    assert.deepEqual(edits, []);
    assert.deepEqual(insertions, []);
  });
}

test('a GPS waypoint ignores its own moving marker and label when snapping', t => {
  const features: MapGeoJSONFeature[] = [];
  const { touch, replacements, previews, setRoute } = setup(t, features);
  const plan = resolve('KSFO 371500N1223000W KSJC');
  const waypoint = plan.waypoints[1]!;
  setRoute(plan);
  touch('touchstart', 1);
  touch('touchmove', 1, 110, [-122.75, 37.5]);
  for (const layer of ['route-waypoints', 'route-waypoint-labels']) features.push({
    ...waypoint.feature, source: ROUTE_SOURCE_ID, layer: { id: layer },
    geometry: { type: 'Point', coordinates: [-122.75, 37.5] },
    properties: { ...waypoint.feature.properties, ...routeEditProperties(waypoint.edit!, plan.revision) },
  } as unknown as MapGeoJSONFeature);
  touch('touchmove', 1, 120, [-122.8, 37.6]);
  assert.equal(previews.at(-1)?.snapped, false);
  touch('touchend', 0);
  assert.deepEqual(replacements[0]!.feature.geometry.coordinates, [-122.8, 37.6]);
});

test('a GPS waypoint can snap to navigation data or leave a snap for another coordinate', t => {
  const features = [{ ...navigation.features[3]!, layer: { id: 'fixes' } } as unknown as MapGeoJSONFeature];
  const { touch, replacements, previews, edits, setRoute } = setup(t, features);
  setRoute(resolve('KSFO 371500N1223000W KSJC'));
  touch('touchstart', 1);
  touch('touchmove', 1, 150);
  assert.equal(previews.at(-1)?.snapped, true);
  touch('touchend', 0);
  assert.equal(replacements[0]!.feature.id, 'OAK');
  touch('touchstart', 1);
  touch('touchmove', 1, 150);
  features.length = 0;
  touch('touchmove', 1, 160, [-121, 36]);
  touch('touchend', 0);
  assert.equal(replacements[1]!.feature.properties.ident, '360000N1210000W');
  assert.deepEqual(edits, []);
});

for (const cancel of ['tap', 'jitter', 'cancel', 'multitouch', 'revision', 'readonly', 'destroy']) {
  test(`${cancel} does not insert a GPS waypoint`, t => {
    const { touch, insertions, gestures, setRoute, setEditable } = setup(t, [], 'leg');
    touch('touchstart', 1);
    if (cancel === 'jitter') touch('touchmove', 1, 103);
    else if (cancel !== 'tap') touch('touchmove', 1, 150);
    if (cancel === 'cancel') touch('touchcancel', 0);
    if (cancel === 'multitouch') touch('touchstart', 2);
    if (cancel === 'revision') setRoute(resolve('KSFO OAK KSJC'));
    if (cancel === 'readonly') setEditable(false);
    if (cancel === 'destroy') gestures.destroy();
    else touch('touchend', 0);
    assert.deepEqual(insertions, []);
  });
  test(`${cancel} does not move or remove a GPS waypoint`, t => {
    const { touch, replacements, edits, gestures, setRoute, setEditable } = setup(t);
    setRoute(resolve('KSFO 371500N1223000W KSJC'));
    touch('touchstart', 1);
    if (cancel === 'jitter') touch('touchmove', 1, 103);
    else if (cancel !== 'tap') touch('touchmove', 1, 150);
    if (cancel === 'cancel') touch('touchcancel', 0);
    if (cancel === 'multitouch') touch('touchstart', 2);
    if (cancel === 'revision') setRoute(resolve('KSFO OAK KSJC'));
    if (cancel === 'readonly') setEditable(false);
    if (cancel === 'destroy') gestures.destroy();
    else touch('touchend', 0);
    assert.deepEqual(replacements, []);
    assert.deepEqual(edits, []);
  });
}

test('a context gesture offers nearby navigation points as one chooser set', t => {
  const first = navigation.features[0]!;
  const second = navigation.features[1]!;
  const { handlers, nearby, selections } = setup(t, [
    { ...first, layer: { id: 'airports' } } as unknown as MapGeoJSONFeature,
    { ...second, layer: { id: 'navaids' } } as unknown as MapGeoJSONFeature,
  ]);
  handlers.get('contextmenu')!({ point: { x: 100, y: 100 }, preventDefault() {} });
  assert.equal(selections.length, 0);
  assert.equal(nearby.length, 1);
  assert.deepEqual(nearby[0]!.map(({ feature }) => feature.properties.ident), ['KSFO', 'SNS']);
});

test('releasing a handled long press suppresses compatibility mouse events and the following map click', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { touch, handlers, click, selections } = setup(t);
  touch('touchstart', 1);
  t.mock.timers.tick(550);
  const selected = selections.length;
  let prevented = false;
  handlers.get('touchend')!({ originalEvent: { touches: [], cancelable: true,
    preventDefault() { prevented = true; } } });
  assert.equal(prevented, true);
  click();
  assert.equal(selections.length, selected);
});

test('nearby results include hidden planned points and distinct repeated route occurrences', t => {
  const { handlers, nearby, map, setRoute } = setup(t);
  const plan = resolve('KSFO 371500N1223000W KSFO');
  setRoute(plan);
  map.project = () => ({ x: 105, y: 100 });
  handlers.get('contextmenu')!({ point: { x: 100, y: 100 }, preventDefault() {} });
  assert.deepEqual(nearby[0]!.map(({ feature, routePointId, routeIndex }) => [feature.properties.ident, routePointId, routeIndex]), [
    ['KSFO', 'token:0', 0], ['371500N1223000W', 'token:1', 1], ['KSFO', 'token:2', 2],
  ]);
});

test('nearby deduplication preserves co-located ID-less entities while combining their map symbols', t => {
  const features = [
    { kind: 'fix', ident: 'ONE' }, { kind: 'fix', ident: 'TWO' }, { kind: 'navaid', ident: 'ONE' },
  ].map(properties => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [-122, 37] }, properties }));
  const rendered = features.flatMap(feature => ['points', 'labels'].map(id => ({ ...feature, layer: { id } })));
  const { handlers, nearby } = setup(t, rendered as unknown as MapGeoJSONFeature[]);
  handlers.get('contextmenu')!({ point: { x: 100, y: 100 }, preventDefault() {} });
  assert.deepEqual(nearby[0]!.map(({ feature }) => [feature.properties.kind, feature.properties.ident]),
    [['fix', 'ONE'], ['fix', 'TWO'], ['navaid', 'ONE']]);
});

test('nearby planned points replace duplicate navigation symbols and labels, with a geographic radius', t => {
  const feature = navigation.features[0]!;
  const { handlers, nearby, map, setRoute } = setup(t, [feature, feature] as unknown as MapGeoJSONFeature[]);
  setRoute(resolve('KSFO SNS'));
  map.project = coordinate => ({ x: coordinate[0] === -122 ? 105 : 131, y: 100 });
  handlers.get('contextmenu')!({ point: { x: 100, y: 100 }, preventDefault() {} });
  assert.equal(nearby[0]!.length, 1);
  assert.equal(nearby[0]![0]!.routePointId, 'token:0');
  assert.equal(nearby[0]![0]!.feature.id, 'KSFO');
});

for (const kind of ['waypoint', 'leg'] as const) for (const cancel of [false, true]) {
  test(`${kind} dragging restores only the committed snap target (cancel: ${cancel})`, t => {
    const features: GeoPointFeature[] = Array.from({ length: 12 }, (_, index) => ({
      type: 'Feature', id: `fix:${index}`, geometry: { type: 'Point', coordinates: [-120 + index / 100, 36] },
      properties: { kind: 'fix', ident: `FIX${index}`, dataSourceKey: 'reference', dataRevision: 'test', charts: ['ENROUTE LOW'] },
    }));
    const references = { ...navigation, features };
    const rendered = withMapLabelKeys(references).features.map(feature => ({ ...feature, id: 0 }));
    const { touch, map, resolutions, insertions, replacements, previews } = setup(t,
      [...rendered, ...rendered] as unknown as MapGeoJSONFeature[], kind, references);
    map.project = coordinate => ({ x: coordinate[0] === features[5]!.geometry.coordinates[0] ? 135 : 1000, y: 100 });
    touch('touchstart', 1);
    for (let i = 0; i < 20; i++) touch('touchmove', 1, 135 + i);
    assert.equal(previews.at(-1)?.snapped, true);
    assert.equal(resolutions.length, 0, 'movement never reads national reference collections');
    touch(cancel ? 'touchcancel' : 'touchend', 0);
    assert.equal(resolutions.length, cancel ? 0 : 1);
    const changes = kind === 'leg' ? insertions : replacements;
    assert.equal(changes.length, cancel ? 0 : 1);
    if (!cancel) assert.equal(changes[0]!.feature, features[5], 'the committed target retains its complete reference data');
  });
}

for (const action of ['click', 'snap'] as const) {
  test(`${action} restores navigation identity and worker-safe properties after tile encoding`, t => {
    const feature: GeoPointFeature = { type: 'Feature', id: 'fix:TAILS',
      geometry: { type: 'Point', coordinates: [-122.52036944, 37.27286111] },
      properties: { kind: 'fix', ident: 'TAILS', charts: ['ENROUTE LOW'] } };
    const mapped = withMapLabelKeys({ ...navigation, features: [feature] }).features[0]!;
    const rendered = {
      type: 'Feature', id: 0,
      geometry: { type: 'Point', coordinates: [-122.52, 37.27] },
      // Vector-tile decoding produces a dictionary, not a normal JSON object.
      properties: Object.assign(Object.create(null), mapped.properties),
    } as unknown as MapGeoJSONFeature;
    assert.equal(mapped.properties.charts, undefined, 'nested detail stays outside MapLibre');
    const { click, touch, selections, replacements, edits } = setup(t, [rendered], 'waypoint', { ...navigation, features: [feature] });
    if (action === 'click') click();
    else {
      touch('touchstart', 1);
      touch('touchmove', 1, 135);
      touch('touchend', 0);
      assert.equal(replacements[0]?.index, 'token:1');
    }
    const selected = action === 'click' ? selections[0] : replacements[0]?.feature;
    assert.ok(selected);
    assert.equal(selected, feature, 'clicks and drag snaps resolve the original complete record');
    assert.equal(Object.getPrototypeOf(selected.properties), Object.prototype);
    assert.equal(Object.getPrototypeOf(rendered.properties), null, 'do not mutate MapLibre data');
    assert.deepEqual(edits, []);
  });
}

for (const comparison of [false, true]) {
  test(`route airport markers and labels remain selectable without navigation symbols (comparison: ${comparison})`, t => {
    const airport: GeoPointFeature = { type: 'Feature', id: 'airport:KSFO',
      geometry: { type: 'Point', coordinates: [-122, 37] },
      properties: { kind: 'airport', ident: 'KSFO', icaoId: 'KSFO', faaId: 'SFO', name: 'San Francisco',
        dataRevision: 'test', dataSourceKey: 'saved:test', elevationFt: 13 } };
    const plan = createRouteResolver([{ ...navigation, meta: { ...navigation.meta, layer: 'airports' }, features: [airport] }])('KSFO');
    let rendered: MapGeoJSONFeature[] = [];
    const renderMap = { setGlobalStateProperty() {}, getSource: (id: string) => id === ROUTE_SOURCE_ID
      ? { setData: (data: { features: MapGeoJSONFeature[] }) => { rendered = data.features; } } : undefined };
    syncRoute(renderMap as unknown as MapLibreMap, plan, undefined,
      comparison ? { selectedKey: 'preview', routes: [{ key: 'preview', plan }] } : undefined);
    const point = rendered.find(feature => feature.geometry.type === 'Point')!;
    const { map, touch, click, selections, edits, setEditable, setRoute } = setup(t);
    setRoute(plan);
    setEditable(!comparison);
    const interactive = createRouteLayer().interactiveLayerIds!;
    for (const layer of ['route-waypoints', 'route-waypoint-labels']) {
      assert.ok(interactive.includes(layer));
      map.queryRenderedFeatures = (_point, { layers }) => layers.includes(ROUTE_WAYPOINT_HIT_LAYER_ID)
        ? [] : [{ ...point, id: 0, source: ROUTE_SOURCE_ID, layer: { id: layer } } as MapGeoJSONFeature];
      touch('touchstart', 1);
      touch('touchend', 0);
      click();
      assert.deepEqual(selections.at(-1), airport, 'selection retains airport details and excludes route editing metadata');
    }
    assert.deepEqual(edits, []);
  });
}

test('a second finger cancels route editing and restores map gestures', t => {
  const { touch, edits, gestures, map } = setup(t);
  touch('touchstart', 1);
  touch('touchmove', 1, 135);
  assert.equal(map.touchZoomRotate.enabled, false);
  touch('touchstart', 2, 150);
  assert.equal(gestures.dragging, false);
  assert.equal(map.touchZoomRotate.enabled, true);
  assert.equal(map.dragPan.enabled, true);
  touch('touchmove', 2, 170);
  touch('touchend', 1);
  touch('touchend', 0);
  assert.deepEqual(edits, []);
});

test('opening a route comparison cancels an in-progress edit without committing it', t => {
  const { touch, edits, gestures, map } = setup(t);
  touch('touchstart', 1);
  touch('touchmove', 1, 135);
  gestures.cancelRouteDrag();
  touch('touchend', 0);
  assert.equal(gestures.dragging, false);
  assert.equal(map.dragPan.enabled, true);
  assert.equal(map.touchZoomRotate.enabled, true);
  assert.deepEqual(edits, []);
});

test('read-only comparison blocks stale editable features while the map worker catches up', t => {
  const { touch, edits, gestures, map, setEditable } = setup(t);
  setEditable(false);
  touch('touchstart', 1);
  touch('touchmove', 1, 150);
  assert.equal(gestures.dragging, false);
  assert.equal(map.dragPan.enabled, true);
  touch('touchend', 0);
  assert.deepEqual(edits, []);
  setEditable(true);
  touch('touchstart', 1);
  touch('touchmove', 1, 150);
  touch('touchend', 0);
  assert.deepEqual(edits, ['token:1'], 'ordinary route editing resumes after comparison closes');
});

test('multitouch move/end and touch cancellation never commit waypoint removal', t => {
  const { touch, edits, target } = setup(t);
  touch('touchstart', 1);
  touch('touchmove', 2, 150);
  touch('touchend', 0);
  touch('touchstart', 1);
  touch('touchmove', 1, 150);
  touch('touchend', 1);
  touch('touchstart', 1);
  touch('touchmove', 1, 150);
  target.dispatchEvent(new Event('touchcancel'));
  touch('touchend', 0);
  assert.deepEqual(edits, []);
});

test('deliberate single-finger drag-off still removes a waypoint; tapping does not', t => {
  const { touch, edits } = setup(t);
  touch('touchstart', 1);
  touch('touchend', 0);
  assert.deepEqual(edits, []);
  touch('touchstart', 1);
  touch('touchmove', 1, 150);
  touch('touchend', 0);
  assert.deepEqual(edits, ['token:1']);
});

test('route changes during a drag never apply the old token index to the new plan', t => {
  const { touch, edits, setRoute, map } = setup(t);
  touch('touchstart', 1);
  touch('touchmove', 1, 150);
  setRoute(resolve('KSFO OAK KSJC'));
  touch('touchend', 0);
  assert.deepEqual(edits, []);
  assert.equal(map.dragPan.enabled, true);
  assert.equal(map.touchZoomRotate.enabled, true);
});

test('old worker hit targets cannot start a drag against a newer route', t => {
  const { touch, gestures, edits, setRoute } = setup(t);
  setRoute(resolve('KSFO OAK KSJC'), false);
  touch('touchstart', 1);
  assert.equal(gestures.dragging, false);
  touch('touchmove', 1, 150);
  touch('touchend', 0);
  assert.deepEqual(edits, []);
});

test('destroy releases every map listener as well as an active drag', t => {
  const { touch, gestures, handlers, edits, map } = setup(t);
  touch('touchstart', 1);
  touch('touchmove', 1, 150);
  gestures.destroy();
  assert.equal(handlers.size, 0);
  assert.equal(map.dragPan.enabled, true);
  assert.deepEqual(edits, []);
});
