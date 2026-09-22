import { PluginScope } from '../../core/layers/bridge';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { MapContributionContext } from '../../core/map/contribution';
import type { MapLayerModule } from '../../core/map/layer';
import type { createLayerInput } from '../../core/layers/input';
import type { RouteEditingStore, RoutePluginInput } from './plugin';
import type { RouteMapEditing } from './public';
import { createRouteLayer } from './layer';
import { fitRoute } from './map-camera';

export function createRouteContribution(input: ReturnType<typeof createLayerInput<RoutePluginInput>>,
  editing: RouteEditingStore, context: MapContributionContext,
  initialView: Pick<RoutePluginInput, 'focusNonce' | 'routePreview'>): MapLayerModule<void> {
  const renderer = createRouteLayer();
  let map: MapLibreMap | undefined;
  let previous: RoutePluginInput | undefined;
  let editingScope: PluginScope | undefined;
  let publishedEditing: RouteMapEditing | undefined;
  // View requests survive renderer remounts; only the rendering cache resets.
  let previousView = context.preserveView ? initialView : { focusNonce: 0, routePreview: undefined };
  const cameraKey = (value: RoutePluginInput['routePreview']) => JSON.stringify([value?.routes.map(route => route.key), value?.inset]);
  const update = () => {
    const next = input.require();
    const changed = previous?.routePreview !== next.routePreview;
    if (!previous || previous.route !== next.route || changed) renderer.update({ route: next.route,
      ...(next.routePreview ? { comparison: next.routePreview } : {}) });
    if (map) {
      const refit = previousView.routePreview !== next.routePreview &&
        (cameraKey(previousView.routePreview) !== cameraKey(next.routePreview) ||
          Boolean(previousView.routePreview?.preserveView && !next.routePreview?.preserveView));
      if ((next.focusNonce > 0 && next.focusNonce !== previousView.focusNonce) ||
        next.routePreview && !next.routePreview.preserveView && refit) {
        fitRoute(map, next.route, next.routePreview, context.targetBearing);
      }
      previousView = { focusNonce: next.focusNonce, routePreview: next.routePreview };
    }
    previous = next;
  };
  const preview: RouteMapEditing = value => context.run(renderer.id, () => renderer.update({
    ...value, ...(input.require().routePreview ? { comparison: input.require().routePreview! } : {}),
  }));
  return {
    ...renderer, update, subscribeInputs: input.select(({ route, routePreview, focusNonce }) => ({ route, routePreview, focusNonce })).subscribe,
    mount(target) {
      previous = undefined;
      renderer.update({ route: input.require().route, ...(input.require().routePreview ? { comparison: input.require().routePreview! } : {}) });
      renderer.mount(target);
      map = target;
      update();
      editingScope = new PluginScope(context.reportError);
      publishedEditing = editingScope.command(preview);
      editing.publish(publishedEditing);
    },
    unmount() {
      // Revoke editing before cleanup; selection cancels any drag and restores pan/pinch.
      editingScope?.dispose(); editingScope = undefined;
      if (editing.getSnapshot() === publishedEditing) editing.publish(undefined);
      publishedEditing = undefined;
      map = undefined;
      renderer.unmount();
      previous = undefined;
    },
  };
}
