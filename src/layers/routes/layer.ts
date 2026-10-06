import type { Map as MapLibreMap } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { createSourceSubmission } from '../../core/map/source-submission';
import type { RoutePlan } from '@zlayer/domain';
import { installRouteLayers, syncRoute, revealRouteDrag, hideRouteDrag, ROUTE_LAYER_IDS, ROUTE_LINE_LAYER_IDS, ROUTE_FOCUS_LAYER_IDS, ROUTE_WAYPOINT_HIT_LAYER_ID, ROUTE_SOURCE_ID, ROUTE_DRAG_SOURCE_ID, RECOMMENDATION_SOURCE_ID, ROUTE_LABEL_BACKGROUND_ID, HOLD_ARROW_IMAGE_ID, type RouteRenderState } from './renderer';
import type { RouteDragPreview } from './public';
import type { RoutePreview } from './map-preview';
import type { MapLayerModule } from '../../core/map/layer';
import { LayerScope } from '../../core/layers/scope';
import { ROUTE_LABEL_IDS_STATE } from '../../core/map/label';
import { focusedLayerId } from '../../core/map/focus';

export type RouteInput = { route: RoutePlan; preview?: RouteDragPreview; comparison?: RoutePreview };
export function createRouteLayer(): MapLayerModule<RouteInput> {
  let map: MapLibreMap | undefined;
  let input: RouteInput | undefined;
  let rendered: RouteRenderState | undefined;
  let scope: LayerScope | undefined;
  type Source = { submission: ReturnType<typeof createSourceSubmission>; data?: FeatureCollection;
    timer?: ReturnType<typeof setTimeout> | undefined; retried: boolean };
  const sources = new Map<string, Source>();
  const visibility = (source: string, show: boolean) => {
    const value = show ? 'visible' : 'none';
    for (const id of ROUTE_LAYER_IDS) if (map?.getLayer(id)?.source === source && map.getLayoutProperty(id, 'visibility') !== value) {
      map.setLayoutProperty(id, 'visibility', value);
    }
  };
  const submit = (id: string, data: FeatureCollection, retry = false) => {
    const source = sources.get(id);
    if (!source) return;
    source.data = data;
    if (!retry) { source.retried = false; clearTimeout(source.timer); source.timer = undefined; }
    if (!data.features.length) visibility(id, false);
    const version = source.submission.begin();
    void source.submission.submit(version, data).then(accepted => {
      if (accepted) visibility(id, data.features.length > 0);
    }).catch(error => source.submission.reject(version, error));
  };
  const retryFailed = () => {
    for (const [id, source] of sources) if (source.submission.failed && source.timer === undefined && source.data) submit(id, source.data, true);
  };
  const render = () => {
    if (map && input) rendered = syncRoute(map, input.route, input.preview, input.comparison, rendered, submit);
  };
  const revealDrag = () => {
    // Read current state instead of retaining an async callback's old gesture.
    const drag = sources.get(ROUTE_DRAG_SOURCE_ID);
    if (map && rendered && !drag?.submission.failed && revealRouteDrag(map, rendered)) render();
  };
  return {
    id: 'route', slot: 'route',
    lineLayerIds: ROUTE_LINE_LAYER_IDS,
    overlayLayerIds: ['route-waypoint-halos', 'route-waypoints', ROUTE_WAYPOINT_HIT_LAYER_ID, 'route-insert-preview'],
    interactiveLayerIds: ['route-waypoints', 'route-waypoint-labels', focusedLayerId('route-waypoints')],
    foregroundLayerIds: ['route-waypoint-labels', 'route-hold-direction'],
    focusedLayerIds: ROUTE_FOCUS_LAYER_IDS,
    mount(target) {
      map = target;
      rendered = undefined;
      scope = new LayerScope();
      scope.add(() => { map = undefined; rendered = undefined; sources.clear(); });
      scope.add(() => target.setGlobalStateProperty(ROUTE_LABEL_IDS_STATE, []));
      for (const id of [ROUTE_LABEL_BACKGROUND_ID, HOLD_ARROW_IMAGE_ID]) scope.add(() => { if (target.hasImage(id)) target.removeImage(id); });
      for (const id of [ROUTE_SOURCE_ID, ROUTE_DRAG_SOURCE_ID, RECOMMENDATION_SOURCE_ID]) {
        scope.add(() => { if (target.getSource(id)) target.removeSource(id); });
      }
      for (const id of ROUTE_LAYER_IDS) scope.add(() => { if (target.getLayer(id)) target.removeLayer(id); });
      scope.add(() => hideRouteDrag(target, rendered));
      installRouteLayers(map);
      for (const id of [ROUTE_SOURCE_ID, ROUTE_DRAG_SOURCE_ID, RECOMMENDATION_SOURCE_ID]) {
        const source: Source = { retried: false, submission: createSourceSubmission(map, id, () => {
          visibility(id, false);
          if (id === ROUTE_DRAG_SOURCE_ID && map && rendered?.drag) {
            hideRouteDrag(map, rendered); rendered.drag.visible = false;
          }
          if (!source.retried && source.data) {
            source.retried = true;
            source.timer = setTimeout(() => { source.timer = undefined; if (source.data) submit(id, source.data, true); }, 100);
          }
        }) };
        sources.set(id, source);
        scope.add(() => { clearTimeout(source.timer); source.submission.destroy(); });
      }
      scope.add(() => target.off('moveend', retryFailed));
      map.on('moveend', retryFailed);
      scope.add(() => target.off('render', revealDrag));
      map.on('render', revealDrag);
      render();
    },
    update(next) {
      input = next;
      // Start worker processing immediately; waiting for a frame here adds a
      // frame of drag latency. The renderer still skips equivalent source data.
      render();
    },
    unmount() {
      scope?.dispose(); scope = undefined;
    },
  };
}
