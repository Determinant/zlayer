import type { CatalogReadSource } from '../read-context';
import { createChartMapLayers } from '../../layers/charts/map';
import { createNavigationLayer } from '../../layers/navigation/map';
import { createRouteLayer } from '../../layers/routes/map';
import type { createMetarLayer } from '../../layers/metar-taf';
import { createTerrainLayer } from '../../layers/terrain/map';
import type { TerrainStatus } from '../../layers/terrain';
import { createObstructionLayer } from '../../layers/obstructions/map';
import type { ObstructionStatus } from '../../layers/obstructions';
import { createOwnshipMapLayer } from '../../layers/ownship/map';
import type { OwnshipLayer } from '../../layers/ownship';
import { createNavaidIdentificationLayer } from '../../layers/navigation/identification-layer';
import { createPlateMapLayer } from '../../layers/plates/map';
import type { PlatesController } from '../../layers/plates/layer';

/** Only products with a map contribution enter the MapLibre host. */
export function createBuiltInMapLayers(catalog: CatalogReadSource, metar: ReturnType<typeof createMetarLayer>,
  onTerrainStatus: (status: TerrainStatus) => void, ownshipProduct: OwnshipLayer, preserveView = false,
  onObstructionStatus: (status: ObstructionStatus) => void = () => {}, platesProduct?: PlatesController) {
  const charts = createChartMapLayers(catalog);
  const navigation = createNavigationLayer();
  const route = createRouteLayer();
  const identification = createNavaidIdentificationLayer();
  const terrain = createTerrainLayer(onTerrainStatus);
  const obstructions = createObstructionLayer(onObstructionStatus);
  const ownship = createOwnshipMapLayer(ownshipProduct, preserveView);
  const plates = platesProduct && createPlateMapLayer(platesProduct);
  return { charts, terrain, plates, obstructions, navigation, metar: metar.map, route, identification, ownship,
    modules: [...charts, terrain, ...(plates ? [plates] : []), obstructions, navigation, metar.map, route, identification, ownship] };
}
