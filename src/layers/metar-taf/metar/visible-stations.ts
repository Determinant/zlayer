import type { Map as MapLibreMap } from 'maplibre-gl';

import { AIRPORT_POINT_LAYER_IDS } from '../../navigation/map-contract';
import { stationIdBatches } from './requests';

export function visibleMetarStationIds(
  map: Pick<MapLibreMap, 'getLayer' | 'queryRenderedFeatures'>,
): string[] {
  const layers = [...AIRPORT_POINT_LAYER_IDS, 'airports-weather-points'].filter((id) => map.getLayer(id));
  if (layers.length === 0) return [];
  const features = map.queryRenderedFeatures({ layers });
  // Circle layers respect the viewport, zoom cutoffs, and Airports visibility.
  // Deduplicate features repeated across tiles or wrapped world copies.
  return stationIdBatches(features.flatMap(({ properties }) =>
    typeof properties.icaoId === 'string' ? [properties.icaoId] : []
  )).flat().sort();
}
