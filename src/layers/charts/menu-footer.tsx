import { formatDate } from '../../core/format/time';
import { routingCatalog, type CatalogReadSource } from '../../workspace/read-context';
import { chartCountForSelection, chartSelectionTitle, type ChartSelection } from './overlays';
export function ChartMenuFooter({ catalog, chartSelection }: { catalog: CatalogReadSource; chartSelection: ChartSelection }) {
  const activeChartCount = chartCountForSelection(catalog.charts, chartSelection);
  return (
            <footer className="panel-footer">
              <span>Chart stack</span>
              <strong>{chartSelectionTitle(chartSelection)}</strong>
              <small>
                {chartSelection.base
                  ? `Cycle ${formatDate(routingCatalog(catalog).revision)} · ${activeChartCount} files · cached as viewed`
                  : 'Continuous basemap'}
              </small>
            </footer>
);
}
