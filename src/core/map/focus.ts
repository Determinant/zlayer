import type { CircleLayerSpecification, ExpressionSpecification, Map as MapLibreMap, SymbolLayerSpecification } from 'maplibre-gl';
import { selectionMatch } from './label';

export function focusedLayerId(id: string): string { return `zlayer-focus-${id}`; }

/** The product owns both layers: one source, style, visibility and failure lifetime. */
export function addFocusableLayer(map: MapLibreMap, layer: CircleLayerSpecification | SymbolLayerSpecification): void {
  map.addLayer(layer);
  const focused: CircleLayerSpecification | SymbolLayerSpecification = {
    ...layer,
    id: focusedLayerId(layer.id),
    // Product renderers use expression filters, never deprecated property filters.
    filter: ['all', (layer.filter ?? true) as ExpressionSpecification | boolean, selectionMatch()],
  };
  if (focused.type === 'symbol') {
    focused.layout = {
      ...focused.layout,
      // The crosshair owns the name. Focus icons cannot be collision-hidden or
      // displace neighboring labels; only the chosen feature enters this layer.
      'text-field': '',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    };
  }
  map.addLayer(focused);
}
