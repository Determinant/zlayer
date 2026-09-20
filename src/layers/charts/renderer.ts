import { browsingCatalog, type CatalogReadSource } from '../../workspace/read-context';
import type { Map as MapLibreMap } from 'maplibre-gl';

import type { Bounds } from '@zlayer/contracts';

import { mbtilesTileUrl, registerMbtilesArchives } from './mbtiles-protocol';
import { CHART_LAYER_ANCHOR } from '../../core/map/layer';
import { regionalBundles } from '../../workspace/read-context';
import { CHART_FAMILIES, chartIsVisible, type ChartSelection, type ChartFamilyId } from './overlays';

const HIGH_DENSITY_CHART_TILE_SIZE = 128;

export function installChartLayers(
  map: MapLibreMap,
  catalog: CatalogReadSource,
  selection: ChartSelection,
  family?: ChartFamilyId,
): void {
  registerMbtilesArchives(catalog);
  const bounds = viewportBounds(map);
  for (const chart of renderedCharts(catalog).filter(chart => !family || chart.kind === family)) {
    const layerId = chartLayerId(chart.id);
    map.addSource(layerId, {
      type: 'raster',
      tiles: [mbtilesTileUrl(chart.id)],
      // Treat each 256 px source tile as 128 CSS px. MapLibre requests the next
      // source zoom and lets WebGL downsample it for crisp chart linework.
      tileSize: HIGH_DENSITY_CHART_TILE_SIZE,
      // Archive zoom limits describe stored tiles, not chart visibility. The
      // protocol builds missing low-zoom overviews from the cached archive.
      minzoom: 0,
      maxzoom: chart.maxZoom,
      bounds: chart.bounds,
      attribution: 'FAA charts',
    });
    map.addLayer({
      id: layerId,
      type: 'raster',
      source: layerId,
      layout: {
        visibility: chartIsVisible(chart, selection, bounds) ? 'visible' : 'none',
      },
      paint: {
        'raster-fade-duration': 0,
        'raster-opacity': 1,
        'raster-resampling': 'linear',
      },
    }, insertionPoint(map, catalog, chart.kind));
  }
}

export function syncChartSelection(
  map: MapLibreMap,
  catalog: CatalogReadSource,
  selection: ChartSelection,
  family?: ChartFamilyId,
): void {
  const bounds = viewportBounds(map);
  for (const chart of renderedCharts(catalog).filter(chart => !family || chart.kind === family)) {
    const layerId = chartLayerId(chart.id);
    const visibility = chartIsVisible(chart, selection, bounds) ? 'visible' : 'none';
    if (map.getLayer(layerId) && map.getLayoutProperty(layerId, 'visibility') !== visibility) {
      map.setLayoutProperty(layerId, 'visibility', visibility);
    }
  }
}

function renderedCharts(catalog: CatalogReadSource) {
  if (!browsingCatalog(catalog).chartPackages && !regionalBundles(catalog).length) return catalog.charts;
  return CHART_FAMILIES.flatMap(overlay => {
    const charts = catalog.charts.filter(chart => chart.kind === overlay.id);
    if (!charts.length) return [];
    return [{
      ...charts[0]!, id: `@${overlay.id}`, title: overlay.title,
      bounds: [-180, -85.0511287798066, 180, 85.0511287798066] as Bounds,
      minZoom: 0, maxZoom: Math.max(...charts.map(chart => chart.maxZoom)),
    }];
  });
}

function viewportBounds(map: MapLibreMap): Bounds {
  const bounds = map.getBounds();
  return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
}

function chartLayerId(chartId: string): string {
  return `chart-${chartId}`;
}

export function chartResourceIds(catalog: CatalogReadSource, family: ChartFamilyId): string[] {
  return renderedCharts(catalog).filter(chart => chart.kind === family).map(chart => chartLayerId(chart.id));
}

/** A refreshed base must stay below overlays already mounted, regardless of update order. */
function insertionPoint(map: MapLibreMap, catalog: CatalogReadSource, kind: string): string | undefined {
  const above = CHART_FAMILIES.slice(CHART_FAMILIES.findIndex(family => family.id === kind) + 1);
  for (const family of above) {
    const id = chartResourceIds(catalog, family.id).find(id => map.getLayer(id));
    if (id) return id;
  }
  return map.getLayer(CHART_LAYER_ANCHOR) ? CHART_LAYER_ANCHOR : undefined;
}
