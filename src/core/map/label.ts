import type { ExpressionSpecification, SymbolLayerSpecification } from 'maplibre-gl';
import type { FeatureCollectionResponse, GeoPointFeature } from '@zlayer/contracts';
import { featureKey } from '@zlayer/domain';

// The route owns these IDs; reference and weather layers omit duplicate names.
export const ROUTE_LABEL_IDS_STATE = 'zlayer-route-label-ids';

export function mapLabelKey(feature: GeoPointFeature): string {
  return feature.id ?? (typeof feature.properties.mapLabelKey === 'string' ? feature.properties.mapLabelKey
    : featureKey(feature));
}

// String GeoJSON IDs do not survive every tile encoder. Keep selection and label
// identity in properties as well, including when a rendered feature is reused.
export function withMapLabelKeys(collection: FeatureCollectionResponse): FeatureCollectionResponse {
  return { ...collection, features: collection.features.map(feature => ({
    ...feature, properties: { ...feature.properties, mapFeatureId: feature.id, mapLabelKey: mapLabelKey(feature) },
  })) };
}

export function labelLayer(
  id: string,
  source: string,
  minzoom: number,
  textField: string | ExpressionSpecification,
  color: string,
  filter?: SymbolLayerSpecification['filter'],
  textSize: readonly [number, number] = [11.5, 15],
): SymbolLayerSpecification {
  return {
    id,
    type: 'symbol',
    source,
    minzoom,
    ...(filter ? { filter } : {}),
    layout: {
      'text-field': ['case',
        ['in', ['coalesce', ['get', 'mapLabelKey'], ''], ['coalesce', ['global-state', ROUTE_LABEL_IDS_STATE], ['literal', []]]],
        '', textField],
      'text-font': ['Noto Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], minzoom, textSize[0], 12, textSize[1]],
      'text-offset': [0, 1.15],
      'text-anchor': 'top',
      'text-optional': true,
    },
    paint: {
      'text-color': color,
      'text-halo-color': 'rgba(4, 10, 18, 0.96)',
      'text-halo-width': 1.5,
    },
  };
}
