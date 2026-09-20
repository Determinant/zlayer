import type { CatalogReadSource } from '../../workspace/read-context';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { installChartLayers, syncChartSelection, chartResourceIds } from './renderer';
import { registerMbtilesArchives } from './mbtiles-protocol';
import { chartSourceKey } from './source-key';
import { NO_CHARTS, type ChartFamilyDefinition, type ChartSelection } from './overlays';
import { type MapLayerModule, removeLayerResources } from '../../core/map/layer';

export type ChartLayerInput = { catalog: CatalogReadSource; selection: ChartSelection };

/** Each VFR/IFR product owns its sources; refreshing them does not recreate the map. */
export function createChartLayer(catalog: CatalogReadSource, definition: ChartFamilyDefinition): MapLayerModule<ChartLayerInput> {
  let map: MapLibreMap | undefined;
  let selection: ChartSelection = NO_CHARTS;
  let sourceKey = chartSourceKey(catalog, definition.id);
  const sync = () => { if (map) syncChartSelection(map, catalog, selection, definition.id); };
  return {
    id: definition.id, slot: 'charts',
    mount(target) {
      map = target;
      installChartLayers(map, catalog, selection, definition.id);
      map.on('move', sync);
    },
    update(value) {
      selection = value.selection;
      if (catalog !== value.catalog) {
        const nextKey = chartSourceKey(value.catalog, definition.id);
        const changed = nextKey !== sourceKey;
        if (map && changed) {
          const ids = chartResourceIds(catalog, definition.id);
          removeLayerResources(map, ids, ids);
        }
        catalog = value.catalog;
        sourceKey = nextKey;
        if (map) {
          registerMbtilesArchives(catalog);
          if (changed) installChartLayers(map, catalog, selection, definition.id);
        }
      }
      sync();
    },
    unmount() {
      if (!map) return;
      map.off('move', sync);
      const ids = chartResourceIds(catalog, definition.id);
      removeLayerResources(map, ids, ids);
      map = undefined;
    },
  };
}
