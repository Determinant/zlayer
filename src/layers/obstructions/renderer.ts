import type { ExpressionSpecification, GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { OBSTRUCTION_SOURCE, OBSTRUCTION_LAYER, OBSTRUCTION_MIN_ZOOM, OBSTRUCTION_ZOOM_TIERS, OBSTRUCTION_ICONS, OBSTRUCTION_COLOR } from './definitions';
import { createObstructionIcon } from './symbols';
import type { ObstructionCollection } from './types';

export const emptyObstructions = (): ObstructionCollection => ({ type: 'FeatureCollection', features: [] });

// Evaluate at the current camera zoom so stale data from a closer view cannot
// bypass the height cutoff, and corridor points become fully visible on zoom-in.
const opacity: ExpressionSpecification = ['step', ['zoom'], ['get', 'routeOpacity'],
  ...OBSTRUCTION_ZOOM_TIERS.flatMap(({ minZoom }) => [minZoom,
    ['case', ['<=', ['get', 'minZoom'], minZoom], 1, ['get', 'routeOpacity']]]),
] as ExpressionSpecification;

export function installObstructions(map: MapLibreMap): void {
  map.addSource(OBSTRUCTION_SOURCE, { type: 'geojson', data: emptyObstructions(), promoteId: 'oas' });
  for (const icon of OBSTRUCTION_ICONS) map.addImage(icon, createObstructionIcon(icon), { pixelRatio: 2 });
  map.addLayer({ id: OBSTRUCTION_LAYER, source: OBSTRUCTION_SOURCE, type: 'symbol',
    // Height-based visibility everywhere, plus the route corridor at any zoom.
    filter: ['any', ['>=', ['zoom'], ['get', 'minZoom']], ['>', ['get', 'routeOpacity'], 0]],
    layout: {
      'icon-image': ['get', 'icon'], 'icon-size': 0.9,
      'icon-allow-overlap': true, 'icon-optional': false, 'text-optional': true,
      'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], OBSTRUCTION_MIN_ZOOM, 10.5, 13, 13],
      'text-variable-anchor': ['left', 'right', 'top', 'bottom'], 'text-radial-offset': 1.3, 'text-justify': 'auto',
      'symbol-sort-key': ['-', 0, ['get', 'elevationMslFt']],
    }, paint: {
      'icon-opacity': opacity, 'text-opacity': opacity,
      'text-color': OBSTRUCTION_COLOR, 'text-halo-color': '#081220', 'text-halo-width': 1.3,
    } });
}

export function syncObstructions(map: MapLibreMap, data: ObstructionCollection): void {
  (map.getSource(OBSTRUCTION_SOURCE) as GeoJSONSource | undefined)?.setData(data);
}
