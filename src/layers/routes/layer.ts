import type { Map as MapLibreMap } from 'maplibre-gl';
import type { RoutePlan } from '@zlayer/domain';
import { installRouteLayers, syncRoute, ROUTE_LAYER_IDS, ROUTE_SOURCE_ID, RECOMMENDATION_SOURCE_ID, ROUTE_LABEL_BACKGROUND_ID, type RouteDragPreview } from './renderer';
import type { RecommendationPreview } from './suggestions';
import { type MapLayerModule, removeLayerResources } from '../../core/map/layer';
import { ROUTE_LABEL_IDS_STATE } from '../../core/map/label';

type RouteInput = { route: RoutePlan; preview?: RouteDragPreview; recommendations?: RecommendationPreview };
export function createRouteLayer(): MapLayerModule<RouteInput> {
  let map: MapLibreMap | undefined;
  let input: RouteInput | undefined;
  return {
    id: 'route', slot: 'route',
    interactiveLayerIds: ['route-waypoints', 'route-waypoint-labels'],
    foregroundLayerIds: ['route-waypoint-labels'],
    mount(target) {
      map = target;
      installRouteLayers(map);
      if (input) syncRoute(map, input.route, input.preview, input.recommendations);
    },
    update(next) { input = next; if (map) syncRoute(map, next.route, next.preview, next.recommendations); },
    unmount() {
      if (map) {
        removeLayerResources(map, ROUTE_LAYER_IDS, [ROUTE_SOURCE_ID, RECOMMENDATION_SOURCE_ID]);
        if (map.hasImage(ROUTE_LABEL_BACKGROUND_ID)) map.removeImage(ROUTE_LABEL_BACKGROUND_ID);
        map.setGlobalStateProperty(ROUTE_LABEL_IDS_STATE, []);
      }
      map = undefined;
    },
  };
}
