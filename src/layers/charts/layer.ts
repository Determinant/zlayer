import type { CatalogReadSource } from '../../workspace/read-context';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { installChartLayers, syncChartSelection, chartResourceIds } from './renderer';
import { observeChartFailures, registerMbtilesArchives, retainChartReaders } from './mbtiles-protocol';
import { observeOfflineInventory } from '../../offline/inventory-events';
import { chartSourceKey } from './source-key';
import { NO_CHARTS, type ChartFamilyDefinition, type ChartSelection } from './overlays';
import { type MapLayerModule, removeLayerResources } from '../../core/map/layer';

export type ChartLayerInput = { catalog: CatalogReadSource; selection: ChartSelection };

/** Each VFR/IFR product owns its sources; refreshing them does not recreate the map. */
export function createChartLayer(catalog: CatalogReadSource, definition: ChartFamilyDefinition): MapLayerModule<ChartLayerInput> {
  let map: MapLibreMap | undefined;
  let selection: ChartSelection = NO_CHARTS;
  let sourceKey = chartSourceKey(catalog, definition.id);
  let failed = false;
  let releaseReaders: (() => void) | undefined;
  let stopObservingFailures: (() => void) | undefined;
  let stopObservingInventory: (() => void) | undefined;
  const sync = () => { if (map) syncChartSelection(map, catalog, selection, definition.id); };
  const retry = () => {
    if (!map || !failed) return;
    failed = false;
    const ids = chartResourceIds(catalog, definition.id);
    removeLayerResources(map, ids, ids);
    installChartLayers(map, catalog, selection, definition.id);
    sync();
  };
  return {
    id: definition.id, slot: 'charts',
    mount(target) {
      map = target;
      releaseReaders = retainChartReaders();
      installChartLayers(map, catalog, selection, definition.id);
      map.on('move', sync);
      stopObservingFailures = observeChartFailures(chartId => {
        if (chartId === `@${definition.id}` || catalog.charts.some(chart =>
          chart.id === chartId && chart.kind === definition.id)) failed = true;
      });
      stopObservingInventory = observeOfflineInventory(retry);
      window.addEventListener('online', retry);
    },
    update(value) {
      selection = value.selection;
      if (catalog !== value.catalog) {
        const nextKey = chartSourceKey(value.catalog, definition.id);
        const changed = nextKey !== sourceKey;
        if (changed) failed = false;
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
      stopObservingFailures?.(); stopObservingFailures = undefined;
      stopObservingInventory?.(); stopObservingInventory = undefined;
      window.removeEventListener('online', retry);
      failed = false;
      try {
        if (map) {
          map.off('move', sync);
          const ids = chartResourceIds(catalog, definition.id);
          removeLayerResources(map, ids, ids);
        }
      } finally {
        map = undefined;
        releaseReaders?.(); releaseReaders = undefined;
      }
    },
  };
}
