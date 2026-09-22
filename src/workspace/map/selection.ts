import { emptyRoutePlan } from '@zlayer/domain';
import type { MapContributionContext } from '../../core/map/contribution';
import type { MapLayerModule } from '../../core/map/layer';
import type { MapSelectionInput } from '../../core/map/selection';
import type { createLayerInput } from '../../core/layers/input';
import { PluginScope, type PluginBridge } from '../../core/layers/bridge';
import type { RoutesApi, RouteMapEditing, RouteEditingActions } from '../../layers/routes/public';
import type { RulerApi } from '../../layers/ruler/public';
import type { PlatesApi } from '../../layers/plates/public';
import type { LayerScope } from '../../core/layers/scope';
import { MapGestures } from '../../layers/routes/map-gestures';

type SelectionBridge = PluginBridge<{ routes: RoutesApi; ruler: RulerApi; plates: PlatesApi }>;

/** One selection lifetime per map, independent of any optional renderer. */
export function createSelectionContribution(input: ReturnType<typeof createLayerInput<MapSelectionInput>>,
  connectPlugins: (scope: LayerScope) => SelectionBridge, context: MapContributionContext): MapLayerModule<void> {
  let scope: PluginScope | undefined;
  const emptyRoute = emptyRoutePlan();
  return { id: 'workspace-selection', slot: 'route', update() {},
    mount() {
      scope = new PluginScope(context.reportError);
      const bridge = connectPlugins(scope);
      let editing: RouteMapEditing | undefined;
      let actions: RouteEditingActions | undefined;
      let route = emptyRoute, previewing = false;
      let activeTool = false;
      const gestures = new MapGestures(context.map, {
        route: () => editing ? route : emptyRoute,
        canEditRoute: () => !!editing && !previewing,
        toolActive: () => activeTool,
        interactiveLayerIds: context.interactiveLayerIds,
        resolveFeature: feature => input.require().resolveFeature(feature),
        preview: value => editing?.(value),
        onSelect: (feature, pointId) => input.require().onSelect(feature, pointId),
        onContextAction: point => bridge.get('plates')?.contextAction(point) ?? false,
        onChooseNearby: (features, point) => input.require().onChooseNearby(features, point),
        onRouteLegInsert: (id, feature) => actions?.insert(id, feature),
        onRouteWaypointReplace: (id, feature) => actions?.replace(id, feature),
        onRouteWaypointRemove: id => actions?.remove(id),
      });
      scope.add(() => gestures.destroy());
      bridge.watch('routes', (api, connection) => {
        const update = (next: RouteMapEditing | undefined) => { editing = next; gestures.cancelInteractions(); };
        // A replaced provider has already revoked its preview callback.
        update(undefined);
        actions = api?.actions;
        if (api) {
          connection.observe(api.plan, value => { route = value; gestures.cancelRouteDrag(); });
          connection.observe(api.preview, value => { previewing = !!value; gestures.cancelRouteDrag(); });
          connection.observe(api.editing, update);
        } else {
          route = emptyRoute; previewing = false;
        }
      });
      bridge.watch('ruler', (api, connection) => {
        const update = (next: boolean) => {
          if (next && !activeTool) gestures.cancelInteractions();
          activeTool = next;
        };
        if (api) connection.observe(api.active, update);
        else update(false);
      });
    },
    unmount() { scope?.dispose(); scope = undefined; },
  };
}
