import type { CatalogReadSource } from '../../workspace/read-context';
import { CHART_FAMILIES } from './overlays';
import { createChartLayer } from './layer';

/** Map contribution of the charts product; loaded with the WebGL workspace. */
export function createChartMapLayers(catalog: CatalogReadSource) {
  return CHART_FAMILIES.map(definition => createChartLayer(catalog, definition));
}
