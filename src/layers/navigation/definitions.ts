import type { NavigationLayerId } from '@zlayer/contracts';

// Background IFR fixes share the cutoff of the last remaining airport circles.
export const AIRPORT_MIN_ZOOM = 6.5;
export const VFR_WAYPOINT_MIN_ZOOM = 10;

export type LayerDefinition = {
  id: NavigationLayerId;
  title: string;
  shortTitle: string;
  color: string;
  layerIds: readonly string[];
};

export const AIRPORT_POINT_LAYER_IDS = [
  'airports-major-points',
  'airports-regional-points',
  'airports-local-points',
];

export const NAVIGATION_LAYERS: readonly LayerDefinition[] = [
  {
    id: 'airports',
    title: 'Airports',
    shortTitle: 'APT',
    color: '#58d3ff',
    layerIds: [
      'airports-major-halo',
      'airports-major-points',
      'airports-major-labels',
      'airports-regional-halo',
      'airports-regional-points',
      'airports-regional-labels',
      'airports-local-halo',
      'airports-local-points',
      'airports-local-labels',
    ],
  },
  {
    id: 'navaids',
    title: 'NAVAIDs',
    shortTitle: 'NAV',
    color: '#b9b8ce',
    layerIds: ['navaids-icons'],
  },
  {
    id: 'fixes',
    title: 'IFR fixes',
    shortTitle: 'FIX',
    color: '#42cde3',
    layerIds: ['fixes-icons'],
  },
  {
    id: 'vfr-waypoints',
    title: 'VFR waypoints',
    shortTitle: 'VFR',
    color: '#ffbd66',
    layerIds: ['vfr-waypoints-icons'],
  },
];

export type LayerVisibility = Record<NavigationLayerId, boolean>;

export const DEFAULT_VISIBILITY: LayerVisibility = {
  airports: true,
  'vfr-waypoints': true,
  navaids: true,
  fixes: true,
};
