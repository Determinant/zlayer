import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { GeoPointFeature } from '@zlayer/contracts';
import { formatWaypointLabel } from '../../core/format/coordinates';
import { removeLayerResources, type MapLayerModule } from '../../core/map/layer';

const SOURCE = 'waypoint-inspection';
const LAYERS = ['waypoint-inspection-point', 'waypoint-inspection-label'];

/** One selected coordinate, with no route membership or editing handles. */
export function createWaypointInspectionLayer(): MapLayerModule<GeoPointFeature | undefined> {
  let map: MapLibreMap | undefined;
  let feature: GeoPointFeature | undefined;
  const data = () => ({ type: 'FeatureCollection' as const, features: feature ? [feature] : [] });
  const render = () => {
    (map?.getSource(SOURCE) as GeoJSONSource | undefined)?.setData(data());
    if (map?.getLayer(LAYERS[1]!)) map.setLayoutProperty(LAYERS[1]!, 'text-field',
      feature ? formatWaypointLabel(feature.properties.ident ?? '').replaceAll('′', "'") : '');
  };
  return {
    id: SOURCE, slot: 'navigation', interactiveLayerIds: LAYERS, foregroundLayerIds: [LAYERS[1]!],
    mount(target) {
      map = target;
      map.addSource(SOURCE, { type: 'geojson', data: data() });
      map.addLayer({ id: LAYERS[0]!, type: 'circle', source: SOURCE,
        paint: { 'circle-radius': 6, 'circle-color': '#e9f7ff', 'circle-stroke-color': '#33c6ff', 'circle-stroke-width': 2 } });
      map.addLayer({ id: LAYERS[1]!, type: 'symbol', source: SOURCE,
        layout: { 'text-font': ['Noto Sans Bold'], 'text-size': 13, 'text-anchor': 'left', 'text-offset': [1, 0],
          'text-allow-overlap': true },
        paint: { 'text-color': '#f4f8fc', 'text-halo-color': '#14222f', 'text-halo-width': 2 } });
      render();
    },
    update(next) { if (feature !== next) { feature = next; render(); } },
    unmount() { if (map) removeLayerResources(map, LAYERS, [SOURCE]); map = undefined; },
  };
}
