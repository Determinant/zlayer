import type { Bounds, GeoPointFeature, NavigationData } from '@zlayer/contracts';
import type { RoutePlan } from '@zlayer/domain';
import type { CatalogReadSource } from '../read-context';
import type { ResourceErrorCode } from '../../core/data/errors';
import type { ChartSelection } from '../../layers/charts';
import type { createMetarLayer } from '../../layers/metar-taf';
import type { LayerVisibility } from '../../layers/navigation/definitions';
import type { FixMapContext } from '../../layers/navigation/fix-display';
import type { RouteRecommendationsMap } from '../../layers/routes/suggestions';
import type { TerrainStatus } from '../../layers/terrain';
import type { ObstructionStatus } from '../../layers/obstructions';
import type { OwnshipLayer } from '../../layers/ownship';
import type { MapView } from './style';
import type { NearbyFeature, SelectFeature } from '../feature-selection';
import type { NavaidIdentification } from '../../layers/navigation/identification-layer';

export type MapInputs = {
  catalog: CatalogReadSource;
  chartSelection: ChartSelection;
  visibility: LayerVisibility;
  fixContext: FixMapContext;
  data: NavigationData;
  route: RoutePlan;
  recommendations: RouteRecommendationsMap | undefined;
  metarEnabled: boolean;
  terrainEnabled: boolean;
  obstructionsEnabled: boolean;
  terrainAltitude: number | null;
  ownshipEnabled: boolean;
  identification?: NavaidIdentification;
};

export type MapCallbacks = {
  onSelect: SelectFeature;
  onChooseNearby?: (features: NearbyFeature[], point: { x: number; y: number }) => void;
  onViewportChange: (bounds: Bounds) => void;
  onViewChange?: (view: MapView) => void;
  onRouteLegInsert: (afterEntryId: string, feature: GeoPointFeature) => void;
  onRouteWaypointReplace: (entryId: string, feature: GeoPointFeature) => void;
  onRouteWaypointRemove: (entryId: string) => void;
  onReady: () => void;
  onTerrainStatus: (status: TerrainStatus) => void;
  onObstructionStatus: (status: ObstructionStatus) => void;
  onError: (message: string, code?: ResourceErrorCode) => void;
};

export type MapAttachment = { metarLayer: ReturnType<typeof createMetarLayer>; ownshipLayer: OwnshipLayer };
