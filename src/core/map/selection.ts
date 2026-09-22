import type { GeoPointFeature } from '@zlayer/contracts';

/** Route occurrence identity belongs to the selection, never to reusable navigation
 * data. Keys identify direct entries or individual children of published items. */
export type NearbyFeature = {
  feature: GeoPointFeature;
  routePointId?: string;
  routeIndex?: number;
};

export type SelectFeature = (feature: GeoPointFeature | undefined, routePointId?: string) => void;
