import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';

import type { GeoPointFeature, NavigationLayerId, PointGeometry } from '@zlayer/contracts';
import type { RouteEditTarget, RouteLeg, RoutePlan } from '@zlayer/domain';
import { unwrapRouteCoordinates } from './geometry';
import { routeEditProperties } from './editing';
import { routePointKeys } from './selection';
import { holdArrowImage } from './hold-arrow';
import type { RoutePreview } from './map-preview';
import { ROUTE_LINE_ANCHOR } from '../../core/map/layer';
import { mapLabelKey, ROUTE_LABEL_IDS_STATE } from '../../core/map/label';

export const ROUTE_LEG_HIT_LAYER_ID = 'route-leg-hits';
export const ROUTE_WAYPOINT_HIT_LAYER_ID = 'route-waypoint-hits';
const ROUTE_COLOR = '#33c6ff';
const APPROACH_RGB = [237, 98, 217] as const;
const ROUTE_HALO_RGB = [4, 20, 34] as const;
const APPROACH_COLOR = `rgb(${APPROACH_RGB.join(',')})`;

export type RouteDragPreview = {
  target: RouteEditTarget;
  revision: number;
  coordinate: PointGeometry['coordinates'];
  snapped: boolean;
};

type RouteProperties = GeoPointFeature['properties'] & {
  routeKind: 'leg' | 'waypoint' | 'insert-preview' | 'approach-extension' | 'approach-hold' | 'approach-missed' | 'hold-direction';
  ident?: string;
  navigationLayer?: NavigationLayerId;
  editKind?: 'leg' | 'waypoint';
  editEntryId?: string;
  planRevision?: number;
  dragging?: boolean;
  snapped?: boolean;
  procedurePreview?: boolean;
  approachPhase?: 'approach' | 'missed';
  approachPoint?: boolean;
  approachRole?: string;
  holdLabelOnRight?: boolean;
  holdBearing?: number;
};

type RouteGeometry =
  | PointGeometry
  | { type: 'LineString'; coordinates: PointGeometry['coordinates'][] };

type RouteFeature = {
  type: 'Feature';
  id?: string;
  geometry: RouteGeometry;
  properties: RouteProperties;
};

type RouteFeatureCollection = {
  type: 'FeatureCollection';
  features: RouteFeature[];
};

export const ROUTE_SOURCE_ID = 'route-plan';
export const RECOMMENDATION_SOURCE_ID = 'route-alternatives';
export const ROUTE_LABEL_BACKGROUND_ID = 'route-label-background';
export const HOLD_ARROW_IMAGE_ID = 'route-hold-arrow';
export const ROUTE_LAYER_IDS = [
  'route-alternative-halo', 'route-alternative-line', 'route-alternative-procedure-line',
  'route-line-halo', 'route-line', 'route-procedure-line', 'route-approach-extension', 'route-approach-line', 'route-missed-line', 'route-waypoint-halos', 'route-waypoints',
  'route-waypoint-labels', 'route-hold-direction', ROUTE_WAYPOINT_HIT_LAYER_ID, ROUTE_LEG_HIT_LAYER_ID, 'route-insert-preview',
];

export function installRouteLayers(map: MapLibreMap): void {
  // Keep the 4px rounded corners fixed while the center stretches to fit each label.
  const size = 24, radius = 8;
  const background = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = Math.max(radius - (x + 0.5), 0, x + 0.5 - (size - radius));
    const dy = Math.max(radius - (y + 0.5), 0, y + 0.5 - (size - radius));
    const alpha = Math.round(255 * Math.min(1, Math.max(0, radius + 0.5 - Math.hypot(dx, dy))));
    background.set([40, 40, 40, alpha], (y * size + x) * 4);
  }
  map.addImage(ROUTE_LABEL_BACKGROUND_ID, {
    width: size, height: size, data: background,
  }, {
    pixelRatio: 2, stretchX: [[radius, size - radius]], stretchY: [[radius, size - radius]],
  });
  map.addImage(HOLD_ARROW_IMAGE_ID, holdArrowImage(APPROACH_RGB, ROUTE_HALO_RGB), { pixelRatio: 2 });
  map.addSource(RECOMMENDATION_SOURCE_ID, { type: 'geojson', data: routeData() });
  map.addLayer({ id: 'route-alternative-halo', type: 'line', source: RECOMMENDATION_SOURCE_ID,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#0b1927', 'line-opacity': 0.72,
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 5.5, 11, 9] } }, ROUTE_LINE_ANCHOR);
  map.addLayer({ id: 'route-alternative-line', type: 'line', source: RECOMMENDATION_SOURCE_ID,
    filter: ['!', ['has', 'procedurePreview']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#bac4ce', 'line-opacity': 0.9,
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 3, 11, 4.5] } }, ROUTE_LINE_ANCHOR);
  map.addLayer({ id: 'route-alternative-procedure-line', type: 'line', source: RECOMMENDATION_SOURCE_ID,
    filter: ['==', ['get', 'procedurePreview'], true],
    paint: { 'line-color': '#bac4ce', 'line-opacity': 0.9, 'line-dasharray': [3, 2],
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 3, 11, 4.5] } }, ROUTE_LINE_ANCHOR);
  map.addSource(ROUTE_SOURCE_ID, {
    type: 'geojson',
    data: routeData(),
  });
  map.addLayer({
    id: 'route-line-halo',
    type: 'line',
    source: ROUTE_SOURCE_ID,
    filter: ['in', ['get', 'routeKind'], ['literal', ['leg', 'approach-hold', 'approach-missed']]],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': `rgba(${ROUTE_HALO_RGB.join(',')},0.72)`,
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 6, 11, 10],
    },
  }, ROUTE_LINE_ANCHOR);
  map.addLayer({
    id: 'route-line',
    type: 'line',
    source: ROUTE_SOURCE_ID,
    filter: ['all', ['==', ['get', 'routeKind'], 'leg'], ['!', ['has', 'procedurePreview']], ['!', ['has', 'approachPhase']]],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ROUTE_COLOR,
      'line-opacity': 0.72,
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 3, 11, 5],
    },
  }, ROUTE_LINE_ANCHOR);
  map.addLayer({
    id: 'route-procedure-line', type: 'line', source: ROUTE_SOURCE_ID,
    filter: ['==', ['get', 'procedurePreview'], true],
    paint: { 'line-color': ROUTE_COLOR, 'line-opacity': 0.72, 'line-dasharray': [3, 2],
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 3, 11, 5] },
  }, ROUTE_LINE_ANCHOR);
  map.addLayer({
    id: 'route-approach-extension', type: 'line', source: ROUTE_SOURCE_ID,
    filter: ['==', ['get', 'routeKind'], 'approach-extension'],
    paint: { 'line-color': '#f3afeb', 'line-opacity': 0.7, 'line-width': 2.5 },
  }, ROUTE_LINE_ANCHOR);
  map.addLayer({
    id: 'route-approach-line', type: 'line', source: ROUTE_SOURCE_ID,
    filter: ['==', ['get', 'approachPhase'], 'approach'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': APPROACH_COLOR, 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 3, 11, 5] },
  }, ROUTE_LINE_ANCHOR);
  map.addLayer({
    id: 'route-missed-line', type: 'line', source: ROUTE_SOURCE_ID,
    filter: ['==', ['get', 'approachPhase'], 'missed'],
    layout: { 'line-join': 'round' },
    paint: { 'line-color': APPROACH_COLOR, 'line-dasharray': [2.5, 1.5], 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 3, 11, 4] },
  }, ROUTE_LINE_ANCHOR);
  map.addLayer({
    id: 'route-waypoint-halos',
    type: 'circle',
    source: ROUTE_SOURCE_ID,
    filter: ['==', ['get', 'routeKind'], 'waypoint'],
    paint: {
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        5, ['case', ['get', 'dragging'], 8, 6],
        11, ['case', ['get', 'dragging'], 11, 9],
      ],
      'circle-color': `rgba(${ROUTE_HALO_RGB.join(',')},0.84)`,
    },
  });
  map.addLayer({
    id: 'route-waypoints',
    type: 'circle',
    source: ROUTE_SOURCE_ID,
    filter: ['==', ['get', 'routeKind'], 'waypoint'],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 3.5, 11, 5.5],
      'circle-color': [
        'case',
        ['get', 'snapped'], '#82e8da',
        ['get', 'dragging'], '#ffd17a',
        '#e9f7ff',
      ],
      'circle-stroke-color': ['case', ['==', ['get', 'approachPoint'], true], APPROACH_COLOR, ROUTE_COLOR],
      'circle-stroke-width': 2,
    },
  });
  map.addLayer({
    id: 'route-waypoint-labels',
    type: 'symbol',
    source: ROUTE_SOURCE_ID,
    minzoom: 3,
    filter: ['==', ['get', 'routeKind'], 'waypoint'],
    layout: {
      'icon-image': ROUTE_LABEL_BACKGROUND_ID,
      'icon-text-fit': 'both',
      'icon-text-fit-padding': [2, 4, 2, 4],
      'icon-rotation-alignment': 'viewport',
      'icon-pitch-alignment': 'viewport',
      'icon-allow-overlap': false,
      'icon-optional': false,
      'text-field': ['step', ['zoom'], ['get', 'ident'], 10,
        ['case', ['has', 'approachRole'], ['concat', ['get', 'ident'], '\n', ['get', 'approachRole']], ['get', 'ident']]],
      'text-font': ['Noto Sans Bold'],
      'text-size': 13,
      'text-max-width': 20,
      // Put hold names on the side away from the racetrack, with vertical fallbacks.
      // Ordinary waypoint names retain their horizontal placement.
      'text-variable-anchor-offset': ['case', ['has', 'holdLabelOnRight'],
        ['case', ['get', 'holdLabelOnRight'],
          ['literal', ['left', [1.3, 0], 'bottom', [0, -1.3], 'top', [0, 1.3], 'right', [-1.3, 0]]],
          ['literal', ['right', [-1.3, 0], 'bottom', [0, -1.3], 'top', [0, 1.3], 'left', [1.3, 0]]]],
        ['literal', ['left', [1.3, 0], 'right', [-1.3, 0]]]],
      'text-justify': 'auto',
      'text-rotation-alignment': 'viewport',
      'text-pitch-alignment': 'viewport',
      'text-allow-overlap': false,
      'text-optional': false,
    },
    paint: {
      'icon-opacity': 0.75,
      'text-color': '#f4f8fc',
    },
  });
  map.addLayer({
    id: 'route-hold-direction', type: 'symbol', source: ROUTE_SOURCE_ID, minzoom: 8,
    filter: ['==', ['get', 'routeKind'], 'hold-direction'],
    layout: {
      'icon-image': HOLD_ARROW_IMAGE_ID,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.85, 11, 1.1],
      'icon-rotate': ['get', 'holdBearing'],
      'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map',
      // Reserve this small space before placing labels, so they can move off the arrow.
      'icon-allow-overlap': false, 'icon-ignore-placement': false, 'icon-padding': 2,
    },
    paint: { 'icon-opacity': 1 },
  });
  map.addLayer({
    id: ROUTE_WAYPOINT_HIT_LAYER_ID,
    type: 'circle',
    source: ROUTE_SOURCE_ID,
    filter: [
      'all',
      ['==', ['get', 'routeKind'], 'waypoint'],
      ['==', ['get', 'editKind'], 'waypoint'],
    ],
    paint: {
      'circle-radius': 18,
      'circle-color': 'rgba(59, 174, 255, 0.01)',
    },
  });
  map.addLayer({
    id: ROUTE_LEG_HIT_LAYER_ID,
    type: 'line',
    source: ROUTE_SOURCE_ID,
    filter: ['all', ['==', ['get', 'routeKind'], 'leg'], ['==', ['get', 'editKind'], 'leg']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-width': 24,
      'line-opacity': 0,
    },
  });
  map.addLayer({
    id: 'route-insert-preview',
    type: 'circle',
    source: ROUTE_SOURCE_ID,
    filter: ['==', ['get', 'routeKind'], 'insert-preview'],
    paint: {
      'circle-radius': 6,
      'circle-color': ['case', ['get', 'snapped'], '#82e8da', '#dff3ff'],
      'circle-stroke-color': ROUTE_COLOR,
      'circle-stroke-width': 2,
    },
  });
}

export type RouteRenderState = {
  plan: RoutePlan;
  preview: RouteDragPreview | undefined;
  editable: boolean;
  alternatives: RoutePlan[];
  labelIds: string[];
  pointKeys: ReturnType<typeof routePointKeys>;
};

export function syncRoute(
  map: MapLibreMap,
  plan: RoutePlan,
  preview?: RouteDragPreview,
  routePreview?: RoutePreview,
  previous?: RouteRenderState,
): RouteRenderState {
  const comparison = routePreview?.routes.length ? routePreview : undefined;
  const selected = comparison?.routes.find(route => route.key === comparison.selectedKey) ?? comparison?.routes[0];
  const displayed = selected?.plan ?? plan;
  if (comparison || preview?.revision !== displayed.revision) preview = undefined;
  const editable = !comparison;
  const samePlan = previous?.plan === displayed;
  const pointKeys = samePlan ? previous.pointKeys : routePointKeys(displayed);
  const labelIds = samePlan ? previous.labelIds : [...new Set(displayed.waypoints.map(waypoint => mapLabelKey(waypoint.feature)))];
  if (!sameItems(previous?.labelIds, labelIds)) map.setGlobalStateProperty(ROUTE_LABEL_IDS_STATE, labelIds);
  if (!samePlan || previous.editable !== editable || !samePreview(previous.preview, preview)) {
    (map.getSource(ROUTE_SOURCE_ID) as GeoJSONSource | undefined)?.setData(routeData(displayed, preview, editable, pointKeys));
  }
  const alternatives = comparison?.routes.filter(route => route !== selected).map(route => route.plan) ?? [];
  if (!sameItems(previous?.alternatives, alternatives)) {
    (map.getSource(RECOMMENDATION_SOURCE_ID) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection',
      features: alternatives.flatMap(route => route.legs.map(leg => legFeature(leg, plan.revision, undefined, false))) });
  }
  return { plan: displayed, preview, editable, alternatives, labelIds, pointKeys };
}

function sameItems<T>(previous: readonly T[] | undefined, next: readonly T[]): boolean {
  return previous?.length === next.length && next.every((item, index) => item === previous[index]);
}

function samePreview(previous: RouteDragPreview | undefined, next: RouteDragPreview | undefined): boolean {
  if (previous === next) return true;
  if (!previous || !next || previous.revision !== next.revision || previous.snapped !== next.snapped ||
    previous.coordinate[0] !== next.coordinate[0] || previous.coordinate[1] !== next.coordinate[1]) return false;
  return previous.target.kind === 'waypoint' && next.target.kind === 'waypoint'
    ? previous.target.entryId === next.target.entryId
    : previous.target.kind === 'leg' && next.target.kind === 'leg' && previous.target.afterEntryId === next.target.afterEntryId;
}

function routeData(plan?: RoutePlan, preview?: RouteDragPreview, editable = true,
  pointKeys = plan ? routePointKeys(plan) : undefined): RouteFeatureCollection {
  if (!plan) return { type: 'FeatureCollection', features: [] };
  if (preview?.revision !== plan.revision) preview = undefined;
  const features: RouteFeature[] = [];
  for (const leg of plan.legs) features.push(legFeature(leg, plan.revision, preview, editable));
  for (const extension of plan.approachExtensions ?? []) features.push({ type: 'Feature',
    geometry: { type: 'LineString', coordinates: unwrapRouteCoordinates(extension) }, properties: { routeKind: 'approach-extension' } });
  for (const depiction of plan.approachDepictions ?? []) {
    features.push({ type: 'Feature',
      geometry: { type: 'LineString', coordinates: unwrapRouteCoordinates(depiction.coordinates) },
      properties: { routeKind: depiction.kind === 'hold' ? 'approach-hold' : 'approach-missed', approachPhase: depiction.phase } });
    if (depiction.kind === 'hold' && depiction.arrow) features.push({ type: 'Feature',
      geometry: { type: 'Point', coordinates: depiction.arrow.coordinate },
      properties: { routeKind: 'hold-direction', holdBearing: depiction.arrow.bearing } });
  }
  for (const waypoint of plan.waypoints) {
    const isDragging = waypoint.edit !== undefined &&
      preview?.target.kind === 'waypoint' &&
      preview.target.entryId === waypoint.edit.entryId;
    features.push({
      type: 'Feature',
      ...(waypoint.feature.id === undefined ? {} : { id: waypoint.feature.id }),
      geometry: {
        type: 'Point',
        coordinates: isDragging
          ? preview!.coordinate
          : waypoint.feature.geometry.coordinates,
      },
      properties: {
        ...waypoint.feature.properties,
        mapFeatureId: waypoint.feature.id,
        ...(editable ? { routePointId: pointKeys!.get(waypoint) } : {}),
        routeKind: 'waypoint',
        ident: waypoint.ident,
        ...(waypoint.approachRole ? { approachRole: waypoint.approachRole } : {}),
        ...(waypoint.approachHold?.inboundCourse === undefined ? {} : { holdLabelOnRight: waypoint.approachHold.inboundCourse < 180 }),
        ...(waypoint.owners.some(owner => owner.kind === 'approach') ? { approachPoint: true } : {}),
        navigationLayer: waypoint.layer,
        ...(!editable || !waypoint.edit ? {} : routeEditProperties(waypoint.edit, plan.revision)),
        dragging: isDragging,
        snapped: isDragging ? preview!.snapped : false,
      },
    });
  }
  if (preview?.target.kind === 'leg' && plan.legs.some(
    (leg) => leg.edit?.afterEntryId === (preview.target.kind === 'leg' ? preview.target.afterEntryId : undefined),
  )) {
    features.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: preview.coordinate,
      },
      properties: {
        routeKind: 'insert-preview',

        snapped: preview.snapped,
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

function legFeature(leg: RouteLeg, revision: number, preview?: RouteDragPreview, editable = true): RouteFeature {
  const draggedWaypoint = preview?.target.kind === 'waypoint' ? preview : undefined;
  const from = draggedWaypoint && leg.from.edit !== undefined &&
    draggedWaypoint.target.kind === 'waypoint' && draggedWaypoint.target.entryId === leg.from.edit.entryId
    ? draggedWaypoint.coordinate
    : leg.from.feature.geometry.coordinates;
  const to = draggedWaypoint && leg.to.edit !== undefined &&
    draggedWaypoint.target.kind === 'waypoint' && draggedWaypoint.target.entryId === leg.to.edit.entryId
    ? draggedWaypoint.coordinate
    : leg.to.feature.geometry.coordinates;
  const coordinates = [from];
  if (preview?.target.kind === 'leg' && preview.target.afterEntryId === leg.edit?.afterEntryId) {
    coordinates.push(preview.coordinate);
  }
  coordinates.push(to);
  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: unwrapRouteCoordinates(leg.geometry ?? coordinates) },
    properties: {
      routeKind: 'leg',
      ...(leg.approachPhase ? { approachPhase: leg.approachPhase } : {}),
      ...(!leg.owners.some(owner => owner.kind === 'procedure') ? {} : { procedurePreview: true }),
      ...(!editable || !leg.edit ? {} : routeEditProperties(leg.edit, revision)),
    },
  };
}
