import type { CatalogReadSource } from '../../workspace/read-context';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { installChartLayers, syncChartSelection, chartResourceIds } from './renderer';
import { observeChartFailures, registerMbtilesArchives, retainChartReaders } from './mbtiles-protocol';
import { observeOfflineInventory } from '../../offline/inventory-events';
import { chartSourceKey } from './source-key';
import { NO_CHARTS, type ChartFamilyDefinition, type ChartSelection } from './overlays';
import type { MapLayerModule } from '../../core/map/layer';
import { LayerScope } from '../../core/layers/scope';

export type ChartLayerInput = { catalog: CatalogReadSource; selection: ChartSelection };

/** Each VFR/IFR product owns its sources; refreshing them does not recreate the map. */
export function createChartLayer(catalog: CatalogReadSource, definition: ChartFamilyDefinition): MapLayerModule<ChartLayerInput> {
  let map: MapLibreMap | undefined;
  let selection: ChartSelection = NO_CHARTS;
  let sourceKey = chartSourceKey(catalog, definition.id);
  let failed = false;
  let scope: LayerScope | undefined, resources: LayerScope | undefined;
  const install = () => {
    if (!map) return;
    const target = map, ids = chartResourceIds(catalog, definition.id);
    resources = new LayerScope();
    for (const id of ids) resources.add(() => { if (target.getSource(id)) target.removeSource(id); });
    for (const id of ids) resources.add(() => { if (target.getLayer(id)) target.removeLayer(id); });
    installChartLayers(target, catalog, selection, definition.id);
  };
  const sync = () => { if (map) syncChartSelection(map, catalog, selection, definition.id); };
  const retry = () => {
    if (!map || !failed) return;
    failed = false;
    resources?.dispose();
    install();
    sync();
  };
  return {
    id: definition.id, slot: 'charts',
    mount(target) {
      map = target;
      scope = new LayerScope();
      scope.add(() => { map = undefined; resources = undefined; failed = false; });
      scope.add(retainChartReaders());
      scope.add(() => resources?.dispose());
      install();
      scope.add(() => target.off('move', sync));
      map.on('move', sync);
      scope.add(observeChartFailures(chartId => {
        if (chartId === `@${definition.id}` || catalog.charts.some(chart =>
          chart.id === chartId && chart.kind === definition.id)) failed = true;
      }));
      scope.add(observeOfflineInventory(retry));
      scope.add(() => window.removeEventListener('online', retry));
      window.addEventListener('online', retry);
    },
    update(value) {
      selection = value.selection;
      if (catalog !== value.catalog) {
        const nextKey = chartSourceKey(value.catalog, definition.id);
        const changed = nextKey !== sourceKey;
        if (changed) failed = false;
        if (map && changed) {
          resources?.dispose();
        }
        catalog = value.catalog;
        sourceKey = nextKey;
        if (map) {
          registerMbtilesArchives(catalog);
          if (changed) install();
        }
      }
      sync();
    },
    unmount() {
      scope?.dispose(); scope = undefined;
    },
  };
}
