import { pluginStorage } from './storage';
import { emptyRoutePlan, type RoutePlan } from '@zlayer/domain';
import { createLayerStore } from '../../core/layers/store';
import type { RoutesApi, RouteMapEditing, RouteEditingActions } from './public';
import type { PluginExports } from '../../core/layers/bridge';
import type { RouteMapPreview } from './map-preview';
import { createLayerInput, selectLayerStore } from '../../core/layers/input';
import type { LayerPlugin } from '../../core/layers/plugin';

export type RoutePluginInput = {
  displayedRoutes?: readonly RoutePlan[];
  route: RoutePlan; routePreview: RouteMapPreview | undefined; focusNonce: number;
  actions: RouteEditingActions;
};
export type RouteEditingStore = ReturnType<typeof createLayerStore<RouteMapEditing | undefined>>;

export function createRoutesPlugin() {
  const input = createLayerInput<RoutePluginInput>();
  const editing = createLayerStore<RouteMapEditing | undefined>(undefined);
  const empty = emptyRoutePlan(), noRoutes: readonly RoutePlan[] = [];
  const plan = selectLayerStore(input, state => state?.route ?? empty);
  const preview = selectLayerStore(input, state => state?.routePreview);
  const displayedRoutes = selectLayerStore(input, state => state?.displayedRoutes ?? noRoutes);
  return {
    publicApi(scope) {
      return { plan: scope.store(plan), preview: scope.store(preview),
        displayedRoutes: scope.store(displayedRoutes), editing: scope.store(editing),
        actions: {
          insert: scope.command((id, feature) => input.require().actions.insert(id, feature)),
          replace: scope.command((id, feature) => input.require().actions.replace(id, feature)),
          remove: scope.command(id => input.require().actions.remove(id)),
        } };
    },
    editing, definition: { id: 'routes', title: 'Routes' }, input, storage: pluginStorage,
    mapContribution: { id: 'routes', async load(context) {
      // Preserve only requests that predate activation. Actions during the import
      // still need to change the map view once the renderer can attach.
      const { focusNonce, routePreview } = input.require();
      const { createRouteContribution } = await import('./map-contribution');
      return [createRouteContribution(input, editing, context, { focusNonce, routePreview })];
    } },
  } satisfies LayerPlugin & PluginExports<RoutesApi> & { input: typeof input; editing: RouteEditingStore };
}
