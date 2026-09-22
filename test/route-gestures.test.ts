import { PluginRegistry } from '../src/core/layers/bridge';
import type { RoutesApi, RouteMapEditing } from '../src/layers/routes/public';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Map as MapLibreMap, MapGeoJSONFeature } from 'maplibre-gl';
import type { FeatureCollectionResponse, GeoPointFeature } from '@zlayer/contracts';
import { createRouteResolver, parseRouteCoordinate, routeCoordinateFeature, type RoutePlan } from '@zlayer/domain';
import { MapGestures } from '../src/workspace/map/gestures';
import { ROUTE_LEG_HIT_LAYER_ID, ROUTE_WAYPOINT_HIT_LAYER_ID, ROUTE_SOURCE_ID, syncRoute, type RouteDragPreview } from '../src/layers/routes/renderer';
import { createRouteLayer } from '../src/layers/routes/layer';
import { routeEditProperties } from '../src/layers/routes/editing';
import type { NearbyFeature } from '../src/workspace/feature-selection';
import { withMapLabelKeys } from '../src/core/map/label';
import { resolveNavigationFeature } from '../src/layers/navigation/feature-details';
import { createLayerInput } from '../src/core/layers/input';
import { createLayerStore } from '../src/core/layers/store';
import { MapLayerHost } from '../src/core/map/layer';
import { createSelectionContribution } from '../src/workspace/map/selection';
import type { MapSelectionInput } from '../src/core/map/selection';

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
  const canvas = Object.assign(new EventTarget(), { style: {}, clientWidth: 1024, clientHeight: 768 });
  let hitBounds: [number, number, number, number] | undefined;
  let boundsQueries = 0;
  const map = {
    on: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler),
    off: (name: string) => handlers.delete(name),
    getLayer: () => true,
    getCenter: () => ({ lng: -122 }),
    unproject: (_point: unknown) => ({ lng: -122, lat: 37 }),
    project: (_coordinate: [number, number]) => ({ x: 150, y: 100 }),
    queryRenderedFeatures: (point: unknown, { layers, filter }: { layers: string[]; filter?: unknown }) => {
      if (filter) {
        boundsQueries++;
        const [[left, top], [right, bottom]] = point as [[number, number], [number, number]];
        return navigationFeatures.filter(feature => {
          const anchor = map.project((feature.geometry as GeoPointFeature['geometry']).coordinates);
          const [l, t, r, b] = hitBounds ?? [anchor.x, anchor.y, anchor.x, anchor.y];
          return l <= right && r >= left && t <= bottom && b >= top;
        });
      }
      return layers.includes(ROUTE_WAYPOINT_HIT_LAYER_ID)
        ? [{ layer: { id: kind === 'leg' ? ROUTE_LEG_HIT_LAYER_ID : ROUTE_WAYPOINT_HIT_LAYER_ID },
          properties: routeEditProperties(kind === 'leg' ? rendered.legs[0]!.edit! : rendered.waypoints[1]!.edit!, rendered.revision) }] : navigationFeatures;
    },
    dragPan: control(), touchZoomRotate: control(), getCanvas: () => canvas,
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
      replacements.push({ index, feature });
    },
    onRouteWaypointRemove: index => edits.push(index),
  });
  t.after(() => { gestures.destroy(); globalThis.window = original; });
  let lastX = 100, lastCoordinate = [-122.5, 37.25];
  const touch = (name: string, count: number, x = name === 'touchstart' ? 100 : lastX,
    coordinate = name === 'touchstart' ? [-122.5, 37.25] : lastCoordinate) => {
    lastX = x; lastCoordinate = coordinate;
    handlers.get(name)!({
      point: { x, y: 100 },
      // MapLibre exposes changedTouches on touchend, including the final position.
      points: Array.from({ length: name === 'touchend' ? 1 : count }, () => ({ x, y: 100 })),
      originalEvent: { type: name, touches: Array.from({ length: count }, () => ({})) },
      lngLat: { lng: coordinate[0], lat: coordinate[1] }, preventDefault() {},
    });
  };
  const mouse = (name: string, x = 100, button = 0, coordinate = [-122.5, 37.25]) => handlers.get(name)!({
    point: { x, y: 100 }, originalEvent: { button },
    lngLat: { lng: coordinate[0], lat: coordinate[1] }, preventDefault() {},
  });
  return { touch, mouse, edits, gestures, map, target, selections, replacements, handlers,
    nearby, insertions, previews, resolutions,
    setHitBounds: (bounds: typeof hitBounds) => { hitBounds = bounds; },
    boundsQueries: () => boundsQueries,
    getRoute: () => route,
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

test('activating a touch drag at exactly six pixels cancels the long press', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { touch, insertions, previews, selections, nearby } = setup(t, [], 'leg');
  touch('touchstart', 1);
  touch('touchmove', 1, 106);
  assert.ok(previews.at(-1));
  t.mock.timers.tick(550);
  assert.deepEqual([selections, nearby], [[], []]);
  assert.ok(previews.at(-1), 'holding an active drag must not open details or cancel it');
  touch('touchend', 0);
  assert.equal(insertions.length, 1);
});

for (const input of ['mouse', 'touch'] as const) test(`${input} free-leg preview follows precise coordinates while the drop retains GPS token precision`, t => {
  const { mouse, touch, previews, insertions } = setup(t, [], 'leg');
  const coordinate: [number, number] = [-119.123456, 35.123456];
  if (input === 'touch') { touch('touchstart', 1); touch('touchmove', 1, 150, coordinate); }
  else { mouse('mousedown'); mouse('mousemove', 150, 0, coordinate); }
  assert.deepEqual(previews.at(-1)?.coordinate, coordinate);
  if (input === 'touch') touch('touchend', 0);
  else mouse('mouseup', 150, 0, coordinate);
  assert.deepEqual(insertions[0]?.feature, routeCoordinateFeature(coordinate));
  assert.notDeepEqual(insertions[0]?.feature.geometry.coordinates, coordinate);
});

for (const gesture of ['right click', 'long press'] as const) {
  test(`an empty-map ${gesture} inspects a wrapped GPS coordinate without editing the route`, t => {
    if (gesture === 'long press') t.mock.timers.enable({ apis: ['setTimeout'] });
    const { map, handlers, touch, selections, nearby, insertions, replacements, edits } = setup(t);
    map.unproject = () => ({ lng: 237.5, lat: 37.25 });
    if (gesture === 'right click') handlers.get('contextmenu')!({ point: { x: 100, y: 100 }, preventDefault() {} });
    else {
      touch('touchstart', 1);
      t.mock.timers.tick(550);
      touch('touchend', 0);
    }
    assert.deepEqual(selections, [parseRouteCoordinate('371500N1223000W')]);
    assert.deepEqual(nearby, []);
    assert.deepEqual([insertions, replacements, edits], [[], [], []]);
  });
}

test('an ordinary empty-map click still clears the selection', t => {
  const { click, selections } = setup(t);
  click();
  assert.deepEqual(selections, [undefined]);
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
  touch('touchmove', 1, 190, [-121, 36]);
  touch('touchend', 0);
  assert.equal(insertions[1]!.feature.properties.ident, '360000N1210000W');
});

test('a snap survives boundary jitter and missing rendered symbols until the pointer leaves its release radius', t => {
  const features = [navigation.features[3]!] as unknown as MapGeoJSONFeature[];
  const { touch, previews, insertions } = setup(t, features, 'leg');
  touch('touchstart', 1);
  touch('touchmove', 1, 127); // 23px from the target at x=150.
  assert.equal(previews.at(-1)?.snapped, true);
  features.length = 0; // Label collision / source refresh temporarily hides the symbol.
  for (const x of [125, 127, 124, 120, 115]) {
    touch('touchmove', 1, x);
    assert.equal(previews.at(-1)?.snapped, true);
    assert.deepEqual(previews.at(-1)?.coordinate, navigation.features[3]!.geometry.coordinates);
  }
  touch('touchend', 0);
  assert.equal(insertions[0]?.feature.id, 'OAK', 'a hidden retained snap still commits the same entity');
  features.push(navigation.features[3]! as unknown as MapGeoJSONFeature);
  touch('touchstart', 1);
  touch('touchmove', 1, 150);
  features.length = 0;
  touch('touchmove', 1, 190);
  assert.equal(previews.at(-1)?.snapped, false, 'leaving the release radius allows a GPS drop');
  touch('touchmove', 1, 175);
  assert.equal(previews.at(-1)?.snapped, false, 're-entry requires a rendered hit');
  features.push(navigation.features[3]! as unknown as MapGeoJSONFeature);
  touch('touchmove', 1, 173);
  assert.equal(previews.at(-1)?.snapped, true);
});

test('snapping preserves rendered label and icon hits beyond the anchor radius, including box corners', t => {
  const features = [navigation.features[3]!] as unknown as MapGeoJSONFeature[];
  const { touch, map, previews } = setup(t, features, 'leg');
  touch('touchstart', 1);
  for (const point of [{ x: 250, y: 100 }, { x: 170, y: 120 }]) {
    map.project = () => point;
    touch('touchmove', 1, 150);
    assert.equal(previews.at(-1)?.snapped, true);
  }
});

test('long-label snaps keep their captured hit area through missing hits without growing with pointer movement', t => {
  const features = [navigation.features[3]!] as unknown as MapGeoJSONFeature[];
  const { touch, map, previews, setHitBounds, boundsQueries } = setup(t, features, 'leg');
  map.project = () => ({ x: 300, y: 100 });
  setHitBounds([140, 94, 305, 106]);
  touch('touchstart', 1);
  touch('touchmove', 1, 150); // Visible label, far from its geographic anchor.
  const measured = boundsQueries();
  assert.ok(measured > 0 && measured < 45, 'capture measures each edge once with logarithmic queries');
  features.length = 0;
  for (const x of [170, 200, 250, 280, 310, 325, 340]) {
    touch('touchmove', 1, x);
    assert.equal(previews.at(-1)?.snapped, true);
  }
  assert.equal(boundsQueries(), measured, 'moving a retained snap never measures its bounds again');
  touch('touchmove', 1, 345);
  assert.equal(previews.at(-1)?.snapped, false, 'moving beyond the captured label and margin releases');
  touch('touchmove', 1, 200);
  assert.equal(previews.at(-1)?.snapped, false, 'a missing hit cannot acquire a new snap');
});

test('a nonfinite projected anchor cannot acquire or retain a snap', t => {
  const features = [navigation.features[3]!] as unknown as MapGeoJSONFeature[];
  const { touch, map, previews, insertions } = setup(t, features, 'leg');
  touch('touchstart', 1);
  map.project = () => ({ x: Infinity, y: 100 });
  touch('touchmove', 1, 150);
  assert.equal(previews.at(-1)?.snapped, false);
  map.project = () => ({ x: 150, y: 100 });
  touch('touchmove', 1, 151);
  assert.equal(previews.at(-1)?.snapped, true);
  map.project = () => ({ x: NaN, y: 100 });
  touch('touchmove', 1, 152);
  assert.equal(previews.at(-1)?.snapped, false);
  touch('touchend', 0);
  assert.equal(insertions[0]?.feature.properties.kind, 'coordinate');
});

test('nearby snap targets do not alternate on query ordering or small distance differences', t => {
  const features = [navigation.features[3]!, navigation.features[2]!] as unknown as MapGeoJSONFeature[];
  const { touch, map, previews } = setup(t, features, 'leg');
  map.project = ([lng]) => ({ x: lng === -119 ? 150 : 170, y: 100 });
  touch('touchstart', 1);
  touch('touchmove', 1, 150);
  for (const x of [159, 161, 159, 162]) {
    features.reverse();
    touch('touchmove', 1, x);
    assert.deepEqual(previews.at(-1)?.coordinate, navigation.features[3]!.geometry.coordinates);
  }
  touch('touchmove', 1, 168);
  assert.deepEqual(previews.at(-1)?.coordinate, navigation.features[2]!.geometry.coordinates,
    'a deliberate move switches to the substantially closer target');
});

test('equidistant initial snap targets are chosen independently of query order', t => {
  const features = [navigation.features[3]!, navigation.features[2]!] as unknown as MapGeoJSONFeature[];
  const { touch, insertions } = setup(t, features, 'leg');
  for (let attempt = 0; attempt < 2; attempt++) {
    features.reverse();
    touch('touchstart', 1);
    touch('touchmove', 1, 150);
    touch('touchend', 0);
  }
  assert.equal(insertions[0]?.feature.id, 'KSJC');
  assert.equal(insertions[1]?.feature.id, 'KSJC');
});

for (const input of ['mouse', 'touch'] as const) {
  test(`${input} commits the release position even when there is no final move event`, t => {
    const { mouse, touch, insertions } = setup(t, [], 'leg');
    if (input === 'mouse') {
      mouse('mousedown'); mouse('mousemove', 150); mouse('mouseup', 170, 0, [-121, 36]);
    } else {
      touch('touchstart', 1); touch('touchmove', 1, 150); touch('touchend', 0, 170, [-121, 36]);
    }
    assert.deepEqual(insertions[0]?.feature.geometry.coordinates, [-121, 36]);
  });

  test(`${input} release at the previewed position cannot acquire a newly rendered snap`, t => {
    const features: MapGeoJSONFeature[] = [];
    const { mouse, touch, insertions, previews } = setup(t, features, 'leg');
    if (input === 'mouse') { mouse('mousedown'); mouse('mousemove', 150); }
    else { touch('touchstart', 1); touch('touchmove', 1, 150); }
    assert.equal(previews.at(-1)?.snapped, false);
    features.push(navigation.features[3]! as unknown as MapGeoJSONFeature);
    if (input === 'mouse') mouse('mouseup', 150);
    else touch('touchend', 0);
    assert.equal(insertions[0]?.feature.properties.kind, 'coordinate');
  });

  test(`${input} release cannot start an edit that never produced a drag preview`, t => {
    const { mouse, touch, insertions } = setup(t, [], 'leg');
    if (input === 'mouse') { mouse('mousedown'); mouse('mouseup', 150); }
    else { touch('touchstart', 1); touch('touchend', 0, 150); }
    assert.deepEqual(insertions, []);
  });
}

test('a fresh pointer press after cancelling a drag can select immediately', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const features = [navigation.features[3]!] as unknown as MapGeoJSONFeature[];
  const { mouse, target, map, click, selections } = setup(t, features, 'leg');
  mouse('mousedown'); mouse('mousemove', 150);
  target.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
  mouse('mouseup', 150);
  // There was no post-drag click: MapLibre discards it using its movement threshold.
  map.getCanvas().dispatchEvent(Object.assign(new Event('pointerdown'), { button: 0, isPrimary: true }));
  mouse('mousedown'); mouse('mouseup'); click();
  assert.equal(selections[0]?.id, 'OAK');
});

test('a route refresh does not cancel an independent empty-map long press', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { map, touch, gestures, selections } = setup(t);
  map.queryRenderedFeatures = () => [];
  touch('touchstart', 1);
  assert.equal(gestures.dragging, false);
  gestures.cancelRouteDrag(); // MapRuntime does this when a plan revision changes.
  t.mock.timers.tick(550);
  assert.equal(selections[0]?.properties.kind, 'coordinate');
});

for (const cancel of ['Escape', 'blur', 'outside mouse', 'outside touch'] as const) {
  test(`${cancel} cancels the drag, restores controls, and clears pending long presses`, t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { touch, mouse, target, gestures, map, insertions, selections, nearby } = setup(t, [], 'leg');
    if (cancel === 'outside mouse') {
      mouse('mousedown'); mouse('mousemove', 150);
      target.dispatchEvent(Object.assign(new Event('mouseup'), { button: 0 }));
    } else {
      touch('touchstart', 1); touch('touchmove', 1, 150);
      if (cancel === 'outside touch') touch('touchend', 0, 1100);
      else target.dispatchEvent(Object.assign(new Event(cancel === 'Escape' ? 'keydown' : 'blur'), { key: cancel }));
      touch('touchend', 0);
    }
    assert.equal(gestures.dragging, false);
    assert.equal(map.dragPan.enabled, true);
    assert.equal(map.touchZoomRotate.enabled, true);
    t.mock.timers.tick(600);
    assert.deepEqual([insertions, selections, nearby], [[], [], []]);
  });
}

test('releasing another mouse button cannot finish a left-button drag', t => {
  const { mouse, target, gestures, insertions } = setup(t, [], 'leg');
  mouse('mousedown'); mouse('mousemove', 150);
  mouse('mouseup', 150, 2);
  target.dispatchEvent(Object.assign(new Event('mouseup'), { button: 2 }));
  assert.equal(gestures.dragging, true);
  assert.deepEqual(insertions, []);
  mouse('mouseup', 160);
  assert.equal(insertions.length, 1);
});

for (const type of ['touchend', 'touchcancel']) {
  test(`${type} from another input cannot finish an active mouse drag`, t => {
    const { mouse, touch, target, gestures, insertions } = setup(t, [], 'leg');
    mouse('mousedown'); mouse('mousemove', 150);
    touch(type, 0);
    target.dispatchEvent(new Event(type));
    assert.equal(gestures.dragging, true);
    assert.deepEqual(insertions, []);
    mouse('mouseup', 150);
    assert.equal(insertions.length, 1);
  });
}

for (const cancel of ['Escape', 'blur']) {
  test(`${cancel} cancels a stationary pending long press`, t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { touch, target, selections, nearby, gestures } = setup(t);
    touch('touchstart', 1);
    target.dispatchEvent(Object.assign(new Event(cancel === 'Escape' ? 'keydown' : 'blur'), { key: cancel }));
    t.mock.timers.tick(600);
    assert.equal(gestures.dragging, false);
    assert.deepEqual([selections, nearby], [[], []]);
  });
}

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
  map.unproject = () => ({ lng: longitude, lat: 35 });
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
  const { touch, replacements, previews, setRoute, map } = setup(t, features);
  map.project = () => ({ x: 120, y: 100 });
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
  touch('touchmove', 1, 190, [-121, 36]);
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
    assert.equal(point.properties.displayIdent, 'KSFO', 'map labels retain their formatted value');
    Object.assign(point.properties, { approachRole: 'IAF', holdLabelOnRight: true, approachPoint: true });
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

test('workspace retry restores route gestures after an initial snapshot failure without remounting', t => {
  const feature = { ...navigation.features[3]!, layer: { id: 'fixes' } } as unknown as MapGeoJSONFeature;
  const fixture = setup(t, [feature]);
  fixture.gestures.destroy();
  const errors: unknown[] = [], selections: Array<GeoPointFeature | undefined> = [];
  const registry = new PluginRegistry<{ routes: RoutesApi; ruler: import('../src/layers/ruler/public').RulerApi;
    plates: import('../src/layers/plates/public').PlatesApi }>(error => errors.push(error));
  const input = createLayerInput<MapSelectionInput>();
  input.set({ resolveFeature: value => value, onSelect: value => selections.push(value), onChooseNearby() {} });
  const plan = createLayerStore(fixture.getRoute());
  let fail = true, reads = 0, activations = 0;
  const provider = registry.registration('routes', { publicApi(scope) {
    activations++;
    return {
      plan: scope.store({ subscribe: plan.subscribe, getSnapshot() {
        reads++; if (fail) throw new Error('route snapshot'); return plan.getSnapshot();
      } }),
      preview: scope.store(createLayerStore(undefined)), displayedRoutes: scope.store(createLayerStore([])),
      editing: scope.store(createLayerStore<RouteMapEditing | undefined>(() => {})),
      actions: { insert() {}, replace() {}, remove() {} },
    };
  } });
  provider.activate();
  const map = fixture.map as unknown as MapLibreMap;
  const selection = createSelectionContribution(input, scope => registry.forScope(scope), {
    map, signal: new AbortController().signal, preserveView: true, interactiveLayerIds: () => ['fixes'],
    occupiedRects: () => [], targetBearing: () => 0, run: (_id, action) => action(), reportError: error => errors.push(error),
  });
  const recovery = registry.scopedConnections;
  try {
    selection.mount(map);
    assert.deepEqual(recovery.failures.getSnapshot(), [{ providerId: 'routes', message: 'route snapshot' }]);
    assert.deepEqual(provider.failures!.getSnapshot(), []);
    fixture.touch('touchstart', 1);
    assert.equal(fixture.map.dragPan.enabled, true, 'failed setup cannot start route editing');
    fixture.touch('touchend', 0);
    fixture.click();
    assert.equal(selections.at(-1)?.id, feature.id, 'ordinary selection still works');
    const click = fixture.handlers.get('click');
    fail = false; recovery.retryFailed();
    assert.deepEqual(recovery.failures.getSnapshot(), []);
    assert.equal(fixture.handlers.get('click'), click, 'retry keeps map gesture listeners attached');
    assert.equal(activations, 1);
    fixture.touch('touchstart', 1);
    assert.equal(fixture.map.dragPan.enabled, false, 'the repaired connection can edit routes');
    selection.unmount();
    assert.equal(fixture.map.dragPan.enabled, true);
    assert.equal(fixture.handlers.size, 0);
    fail = true; selection.mount(map);
    assert.equal(recovery.failures.getSnapshot().length, 1);
    selection.unmount();
    assert.deepEqual(recovery.failures.getSnapshot(), []);
    const finalReads = reads;
    recovery.retryFailed();
    assert.equal(reads, finalReads);
    assert.equal(fixture.handlers.size, 0, 'a retained retry cannot revive a detached map');
    assert.equal(errors.length, 2);
  } finally { selection.unmount(); provider.deactivate(); }
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


for (const failure of ['move', 'release'] as const) test(`a route preview failure on ${failure} preserves core selection and cancels the edit`, t => {
  const feature = { ...navigation.features[3]!, layer: { id: 'fixes' } } as unknown as MapGeoJSONFeature;
  const fixture = setup(t, [feature]);
  fixture.gestures.destroy();
  const selections: Array<GeoPointFeature | undefined> = [], errors: string[] = [];
  const editing = createLayerStore<RouteMapEditing | undefined>(undefined);
  const input = createLayerInput<MapSelectionInput>();
  input.set({ resolveFeature: value => value, onSelect: value => selections.push(value), onChooseNearby() {} });
  const map = fixture.map as unknown as MapLibreMap;
  const host = new MapLayerHost(map, (id, error) => errors.push(`${id}:${String(error)}`));
  const registry = new PluginRegistry<{ routes: RoutesApi; ruler: import('../src/layers/ruler/public').RulerApi; plates: import('../src/layers/plates/public').PlatesApi }>();
  const registration = registry.registration('routes', { publicApi: () => ({
    plan: createLayerStore(fixture.getRoute()), preview: createLayerStore(undefined), displayedRoutes: createLayerStore([]), editing,
    actions: {
      insert() { assert.fail('must not edit after renderer failure'); },
      replace() { assert.fail('must not edit after renderer failure'); },
      remove() { assert.fail('must not edit after renderer failure'); },
    },
  }) });
  registration.activate();
  t.after(() => registration.deactivate());
  const selection = createSelectionContribution(input, scope => registry.forScope(scope), { map, signal: new AbortController().signal, preserveView: true,
    interactiveLayerIds: () => ['fixes'], occupiedRects: () => [], targetBearing: () => 0,
    run: (id, action) => host.run(id, action), reportError: error => { throw error; },
  });
  const renderer = { id: 'route', slot: 'route' as const, update() {},
    mount() { editing.publish(value => host.run('route', () => {
      if (failure === 'move' || !value.preview) throw new Error('preview failed');
    })); },
    unmount() { editing.publish(undefined); },
  };
  try {
    host.mount([renderer, selection]);
    fixture.touch('touchstart', 1);
    assert.equal(fixture.map.dragPan.enabled, false);
    fixture.touch('touchmove', 1, 150);
    if (failure === 'release') fixture.touch('touchend', 0);
    assert.equal(editing.getSnapshot(), undefined);
    assert.equal(fixture.map.dragPan.enabled, true);
    assert.equal(fixture.map.touchZoomRotate.enabled, true);
    assert.deepEqual(errors, ['route:Error: preview failed']);
    const click = fixture.handlers.get('click');
    host.reconcile([renderer, selection]);
    assert.equal(fixture.handlers.get('click'), click, 'failure does not replace selection listeners');
    fixture.click(); // Consume the cancelled drag's compatibility click.
    fixture.click();
    assert.equal(selections.at(-1)?.id, feature.id);
    fixture.mouse('contextmenu');
    assert.equal(selections.at(-1)?.id, feature.id);
    assert.equal(selections.length, 2);
  } finally { host.unmount(); }
});
