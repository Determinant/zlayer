import type { GeoPointFeature } from '@zlayer/contracts';

/** Route occurrence identity belongs to the selection, never to reusable navigation
 * data. Keys identify direct entries or individual children of published items. */
export type NearbyFeature = {
  feature: GeoPointFeature;
  routePointId?: string;
  routeIndex?: number;
};

export type SelectFeature = (feature: GeoPointFeature | undefined, routePointId?: string) => void;

/** Applicable plugin actions share the map's nearby-feature menu. */
export type MapContextAction = { id: string; label: string; select(): void };

/** Workspace selection inputs remain available without an editing plugin. */
export type MapSelectionInput = {
  resolveFeature(feature: GeoPointFeature): GeoPointFeature;
  onSelect: SelectFeature;
  onChooseNearby(features: NearbyFeature[], point: { x: number; y: number }, actions?: MapContextAction[]): void;
  onCloseNearby?(): void;
};
