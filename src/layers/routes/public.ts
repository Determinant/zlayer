import type { GeoPointFeature, PointGeometry } from '@zlayer/contracts';
import type { RouteEditTarget, RoutePlan } from '@zlayer/domain';
import type { LayerStore } from '../../core/layers/store';
import type { RouteMapPreview } from './map-preview';

export type RouteDragPreview = {
  target: RouteEditTarget;
  revision: number;
  coordinate: PointGeometry['coordinates'];
  snapped: boolean;
};
export type RouteEditingActions = {
  insert(afterEntryId: string, feature: GeoPointFeature): void;
  replace(entryId: string, feature: GeoPointFeature): void;
  remove(entryId: string): void;
};

/** Present only while a healthy route renderer is attached. */
export type RouteMapEditing = (input: { route: RoutePlan; preview?: RouteDragPreview }) => void;
export type RoutesApi = {
  readonly plan: LayerStore<RoutePlan>;
  readonly preview: LayerStore<RouteMapPreview | undefined>;
  readonly displayedRoutes: LayerStore<readonly RoutePlan[]>;
  readonly editing: LayerStore<RouteMapEditing | undefined>;
  readonly actions: RouteEditingActions;
};
