import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { FeatureCollectionResponse } from '@zlayer/contracts';
import { labelLayer, withMapLabelKeys } from '../../../core/map/label';
import { AIRPORT_MIN_ZOOM } from '../../navigation/definitions';

export const METAR_LAYER_IDS = ['airports-weather-halo', 'airports-weather-points', 'airports-weather-labels'];
export const METAR_SOURCE_ID = 'metar-airports';

export function installMetarLayers(map: MapLibreMap, data: FeatureCollectionResponse): void {
  map.addSource(METAR_SOURCE_ID, { type: 'geojson', data: withMapLabelKeys(data) });
  map.addLayer({
    id: 'airports-weather-halo',
    type: 'circle',
    source: 'metar-airports',
    minzoom: AIRPORT_MIN_ZOOM,
    filter: ['has', 'displayFlightCategory'],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 6.2, 11, 10.1],
      'circle-color': 'rgba(4, 10, 18, 0.9)',
      'circle-stroke-color': 'rgba(4, 10, 18, 0.96)',
      'circle-stroke-width': 1,
    },
  });
  map.addLayer({
    id: 'airports-weather-points',
    type: 'circle',
    source: 'metar-airports',
    minzoom: AIRPORT_MIN_ZOOM,
    filter: ['has', 'displayFlightCategory'],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 5.1, 11, 8.3],
      'circle-color': [
        'match',
        ['get', 'displayFlightCategory'],
        'VFR', '#20c66b',
        'MVFR', '#2787ff',
        'IFR', '#f04444',
        'LIFR', '#d847e8',
        '#8795a1',
      ],
      'circle-stroke-color': 'rgba(255, 255, 255, 0.94)',
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 6, 1.2, 11, 1.7],
    },
  });
  map.addLayer(labelLayer(
    'airports-weather-labels',
    'metar-airports',
    AIRPORT_MIN_ZOOM + 0.35,
    ['coalesce', ['get', 'icaoId'], ['get', 'faaId']],
    '#f4fbff',
    ['has', 'displayFlightCategory'],
  ));
}


export function syncMetarMap(map: MapLibreMap, data: FeatureCollectionResponse | undefined, visible: boolean): void {
  if (data) (map.getSource(METAR_SOURCE_ID) as GeoJSONSource | undefined)?.setData(withMapLabelKeys(data));
  const visibility = visible ? 'visible' : 'none';
  for (const id of METAR_LAYER_IDS) {
    if (map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== visibility) {
      map.setLayoutProperty(id, 'visibility', visibility);
    }
  }
}
