import type {
  ExpressionSpecification,
  GeoJSONSource,
  Map as MapLibreMap,
} from 'maplibre-gl';

import type {
  FeatureCollectionResponse,
  NavigationData,
  NavigationLayerId,
} from '@zlayer/contracts';

import { labelLayer, withMapLabelKeys } from '../../core/map/label';
import { NAVIGATION_LAYERS, AIRPORT_MIN_ZOOM, AIRPORT_POINT_LAYER_IDS, VFR_WAYPOINT_MIN_ZOOM, type LayerVisibility } from './definitions';
import { createNavigationIcon, FIX_ICON_IMAGE, NAVAID_ICON_IMAGE, NAVIGATION_ICON_IDS } from './symbols';
import { priorityFixData } from './fix-display';

export const PRIORITY_FIX_SOURCE_ID = 'nav-priority-fixes';
export const PRIORITY_FIX_LAYER_ID = 'fixes-priority-icons';

export const INTERACTIVE_LAYER_IDS = [
  ...AIRPORT_POINT_LAYER_IDS,
  'airports-major-labels',
  'airports-regional-labels',
  'airports-local-labels',
  'vfr-waypoints-icons',
  'navaids-icons',
  'fixes-icons',
  PRIORITY_FIX_LAYER_ID,
];

const EMPTY_COLLECTION: FeatureCollectionResponse = {
  type: 'FeatureCollection',
  features: [],
  meta: { revision: '', layer: 'airports', returned: 0, truncated: false },
};
const MAJOR_AIRPORT_FILTER: ExpressionSpecification = [
  'all',
  ['==', ['get', 'facilityType'], 'A'],
  [
    'any',
    ['==', ['get', 'towered'], true],
    ['>=', ['coalesce', ['get', 'longestRunwayFt'], 0], 6000],
  ],
];
const REGIONAL_AIRPORT_FILTER: ExpressionSpecification = [
  'all',
  ['==', ['get', 'facilityType'], 'A'],
  ['==', ['get', 'use'], 'PU'],
  [
    '!',
    [
      'any',
      ['==', ['get', 'towered'], true],
      ['>=', ['coalesce', ['get', 'longestRunwayFt'], 0], 6000],
    ],
  ],
];
const LOCAL_AIRPORT_FILTER: ExpressionSpecification = [
  '!',
  ['any', MAJOR_AIRPORT_FILTER, REGIONAL_AIRPORT_FILTER],
];

export function installNavigationLayers(map: MapLibreMap): void {
  for (const layer of NAVIGATION_LAYERS) {
    map.addSource(navigationSourceId(layer.id), {
      type: 'geojson',
      data: emptyFor(layer.id),
    });
  }

  addAirportTier(map, 'major', AIRPORT_MIN_ZOOM, MAJOR_AIRPORT_FILTER);
  addAirportTier(map, 'regional', 8.2, REGIONAL_AIRPORT_FILTER);
  addAirportTier(map, 'local', 10.5, LOCAL_AIRPORT_FILTER);

  for (const id of NAVIGATION_ICON_IDS) {
    map.addImage(id, createNavigationIcon(id), { pixelRatio: 2 });
  }
  const visualWaypoints = labelLayer(
    'vfr-waypoints-icons',
    'nav-vfr-waypoints',
    VFR_WAYPOINT_MIN_ZOOM,
    ['get', 'ident'],
    '#ffcf86',
  );
  // One placement decision and one zoom threshold for the VPxxx name and icon.
  map.addLayer({
    ...visualWaypoints,
    layout: {
      ...visualWaypoints.layout,
      'icon-image': 'vfr-diamond',
      'icon-size': 0.85,
      'icon-optional': false,
      'text-optional': false,
    },
  });

  const navaids = labelLayer(
    'navaids-icons',
    'nav-navaids',
    8,
    ['get', 'ident'],
    '#d4c1ff',
    undefined,
    [10, 13],
  );
  map.addLayer({
    ...navaids,
    layout: {
      ...navaids.layout,
      'icon-image': NAVAID_ICON_IMAGE,
      'icon-size': 0.74,
      // A crowded label must never make a navigation station disappear.
      'icon-allow-overlap': true,
      'icon-ignore-placement': false,
      'icon-optional': false,
      'text-optional': true,
      'text-offset': [0, 0],
      'text-variable-anchor': ['top', 'bottom', 'left', 'right'],
      'text-radial-offset': 1.3,
      'text-justify': 'auto',
    },
  });

  const fixes = labelLayer(
    'fixes-icons',
    'nav-fixes',
    AIRPORT_MIN_ZOOM,
    ['get', 'ident'],
    '#b6eff7',
    ['>=', ['zoom'], ['get', 'mapFixMinZoom']],
  );
  // Place each fix and its name together, including when resolving collisions.
  map.addLayer({
    ...fixes,
    layout: {
      ...fixes.layout,
      'icon-image': FIX_ICON_IMAGE,
      'icon-size': 0.85,
      'icon-optional': false,
      'text-optional': false,
      'symbol-sort-key': ['get', 'mapFixPriority'],
    },
  });
  // Context fixes are separate from the optional background: selection and the
  // active route remain visible even with IFR fixes switched off.
  map.addSource(PRIORITY_FIX_SOURCE_ID, { type: 'geojson', data: priorityFixData([]) });
  const priority = labelLayer(PRIORITY_FIX_LAYER_ID, PRIORITY_FIX_SOURCE_ID, 3,
    ['get', 'ident'], '#d5fbff');
  map.addLayer({
    ...priority,
    layout: {
      ...priority.layout,
      'icon-image': FIX_ICON_IMAGE,
      'icon-size': 0.85,
      'icon-allow-overlap': true,
      'text-optional': true,
      'icon-optional': false,
      'symbol-z-order': 'source',
      'text-offset': [0, 0],
      'text-variable-anchor': ['top', 'bottom', 'left', 'right'],
      'text-radial-offset': 1.15,
      'text-justify': 'auto',
    },
  });
}

export function syncNavigationData(map: MapLibreMap, data: NavigationData, previous?: NavigationData): void {
  for (const layer of NAVIGATION_LAYERS) {
    if (previous && previous[layer.id] === data[layer.id]) continue;
    const source = map.getSource(navigationSourceId(layer.id)) as GeoJSONSource | undefined;
    source?.setData(withMapLabelKeys(data[layer.id] ?? emptyFor(layer.id)));
  }
}

export function syncVisibility(map: MapLibreMap, visibility: LayerVisibility): void {
  for (const definition of NAVIGATION_LAYERS) {
    const value = visibility[definition.id] ? 'visible' : 'none';
    for (const layerId of definition.layerIds) {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', value);
    }
  }
}

function addAirportTier(
  map: MapLibreMap,
  tier: 'major' | 'regional' | 'local',
  minzoom: number,
  filter: ExpressionSpecification,
): void {
  map.addLayer({
    id: `airports-${tier}-halo`,
    type: 'circle',
    source: 'nav-airports',
    minzoom,
    filter,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 6.2, 11, 10.1],
      'circle-color': 'rgba(8, 17, 31, 0.78)',
      'circle-stroke-color': 'rgba(8, 17, 31, 0.92)',
      'circle-stroke-width': 1,
    },
  });
  map.addLayer({
    id: `airports-${tier}-points`,
    type: 'circle',
    source: 'nav-airports',
    minzoom,
    filter,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 5.1, 11, 8.3],
      'circle-color': '#8795a1',
      'circle-stroke-color': 'rgba(255, 255, 255, 0.94)',
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 6, 1.2, 11, 1.7],
    },
  });
  map.addLayer(labelLayer(
    `airports-${tier}-labels`,
    'nav-airports',
    minzoom + 0.35,
    ['coalesce', ['get', 'icaoId'], ['get', 'faaId']],
    '#d9f5ff',
    filter,
  ));
}

function navigationSourceId(layerId: NavigationLayerId): string {
  return `nav-${layerId}`;
}

function emptyFor(layer: NavigationLayerId): FeatureCollectionResponse {
  return { ...EMPTY_COLLECTION, meta: { ...EMPTY_COLLECTION.meta, layer } };
}
