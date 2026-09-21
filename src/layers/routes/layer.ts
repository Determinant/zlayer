import type { Map as MapLibreMap } from 'maplibre-gl';
import type { RoutePlan } from '@zlayer/domain';
import { installRouteLayers, syncRoute, ROUTE_LAYER_IDS, ROUTE_SOURCE_ID, RECOMMENDATION_SOURCE_ID, ROUTE_LABEL_BACKGROUND_ID, HOLD_ARROW_IMAGE_ID, type RouteDragPreview, type RouteRenderState } from './renderer';
import type { RoutePreview } from './map-preview';
import { type MapLayerModule, removeLayerResources } from '../../core/map/layer';
import { ROUTE_LABEL_IDS_STATE } from '../../core/map/label';

type RouteInput = { route: RoutePlan; preview?: RouteDragPreview; comparison?: RoutePreview };
export function createRouteLayer(): MapLayerModule<RouteInput> {
  let map: MapLibreMap | undefined;
  let input: RouteInput | undefined;
  let rendered: RouteRenderState | undefined;
  const render = () => {
    if (map && input) rendered = syncRoute(map, input.route, input.preview, input.comparison, rendered);
  };
  return {
    id: 'route', slot: 'route',
    interactiveLayerIds: ['route-waypoints', 'route-waypoint-labels'],
    foregroundLayerIds: ['route-waypoint-labels', 'route-hold-direction'],
    mount(target) {
      map = target;
      rendered = undefined;
      installRouteLayers(map);
      render();
    },
    update(next) {
      input = next;
      // Start worker processing immediately; waiting for a frame here adds a
      // frame of drag latency. The renderer still skips equivalent source data.
      render();
    },
    unmount() {
      if (map) {
        removeLayerResources(map, ROUTE_LAYER_IDS, [ROUTE_SOURCE_ID, RECOMMENDATION_SOURCE_ID]);
        if (map.hasImage(ROUTE_LABEL_BACKGROUND_ID)) map.removeImage(ROUTE_LABEL_BACKGROUND_ID);
        if (map.hasImage(HOLD_ARROW_IMAGE_ID)) map.removeImage(HOLD_ARROW_IMAGE_ID);
        map.setGlobalStateProperty(ROUTE_LABEL_IDS_STATE, []);
      }
      map = undefined;
      rendered = undefined;
    },
  };
}
