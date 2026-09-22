import { emptyRoutePlan } from '@zlayer/domain';
import type { MapContributionContext } from '../../core/map/contribution';
import type { MapLayerModule } from '../../core/map/layer';
import type { createLayerInput } from '../../core/layers/input';
import type { LayerStore } from '../../core/layers/store';
import { LayerScope } from '../../core/layers/scope';
import { MapGestures } from '../../layers/routes/map-gestures';
import type { RouteMapEditing, RoutePluginInput } from '../../layers/routes/plugin';

type SelectionDependencies = {
  activeTool: LayerStore<{ active: boolean }>;
  editing: LayerStore<RouteMapEditing | undefined>;
  contextAction(point: { x: number; y: number }): boolean;
};

/** One selection lifetime per map, independent of any optional renderer. */
export function createSelectionContribution(input: ReturnType<typeof createLayerInput<RoutePluginInput>>,
  dependencies: SelectionDependencies, context: MapContributionContext): MapLayerModule<void> {
  let scope: LayerScope | undefined;
  const emptyRoute = emptyRoutePlan();
  return { id: 'workspace-selection', slot: 'route', update() {},
    mount() {
      scope = new LayerScope(context.reportError);
      const gestures = new MapGestures(context.map, {
        route: () => dependencies.editing.getSnapshot() ? input.require().route : emptyRoute,
        canEditRoute: () => !!dependencies.editing.getSnapshot() && !input.require().routePreview,
        toolActive: () => dependencies.activeTool.getSnapshot().active,
        interactiveLayerIds: context.interactiveLayerIds,
        resolveFeature: feature => input.require().resolveFeature(feature),
        preview: value => dependencies.editing.getSnapshot()?.(value),
        onSelect: (feature, pointId) => input.require().onSelect(feature, pointId),
        onContextAction: dependencies.contextAction,
        onChooseNearby: (features, point) => input.require().onChooseNearby(features, point),
        onRouteLegInsert: (id, feature) => input.require().onRouteLegInsert(id, feature),
        onRouteWaypointReplace: (id, feature) => input.require().onRouteWaypointReplace(id, feature),
        onRouteWaypointRemove: id => input.require().onRouteWaypointRemove(id),
      });
      scope.add(() => gestures.destroy());
      scope.add(dependencies.editing.subscribe(() => gestures.cancelInteractions()));
      scope.add(input.select(({ route, routePreview }) => ({ revision: route.revision, routePreview }))
        .subscribe(() => gestures.cancelRouteDrag()));
      let active = dependencies.activeTool.getSnapshot().active;
      scope.add(dependencies.activeTool.subscribe(() => {
        const next = dependencies.activeTool.getSnapshot().active;
        if (next && !active) gestures.cancelInteractions();
        active = next;
      }));
    },
    unmount() { scope?.dispose(); scope = undefined; },
  };
}
