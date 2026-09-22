import { pluginStorage } from './storage';
import type { RoutePlan } from '@zlayer/domain';
import type { GeoPointFeature } from '@zlayer/contracts';
import type { NearbyFeature, SelectFeature } from '../../core/map/selection';
import { createLayerStore } from '../../core/layers/store';
import type { RouteInput } from './layer';
import type { RouteMapPreview } from './map-preview';
import { createLayerInput } from '../../core/layers/input';
import type { LayerPlugin } from '../../core/layers/plugin';

export type RoutePluginInput = {
  route: RoutePlan; routePreview: RouteMapPreview | undefined; focusNonce: number;
  resolveFeature(feature: GeoPointFeature): GeoPointFeature;
  onSelect: SelectFeature;
  onChooseNearby(features: NearbyFeature[], point: { x: number; y: number }): void;
  onRouteLegInsert(afterEntryId: string, feature: GeoPointFeature): void;
  onRouteWaypointReplace(entryId: string, feature: GeoPointFeature): void;
  onRouteWaypointRemove(entryId: string): void;
};
/** Present only while a healthy route renderer is attached. */
export type RouteMapEditing = (input: Pick<RouteInput, 'route' | 'preview'>) => void;
export type RouteEditingStore = ReturnType<typeof createLayerStore<RouteMapEditing | undefined>>;

export function createRoutesPlugin() {
  const input = createLayerInput<RoutePluginInput>();
  const editing = createLayerStore<RouteMapEditing | undefined>(undefined);
  return {
    editing, definition: { id: 'routes', title: 'Routes' }, input, storage: pluginStorage,
    mapContribution: { id: 'routes', async load(context) {
      // Preserve only requests that predate activation. Actions during the import
      // still need to change the map view once the renderer can attach.
      const { focusNonce, routePreview } = input.require();
      const { createRouteContribution } = await import('./map-contribution');
      return [createRouteContribution(input, editing, context, { focusNonce, routePreview })];
    } },
  } satisfies LayerPlugin & { input: typeof input; editing: RouteEditingStore };
}
