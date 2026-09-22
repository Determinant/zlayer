import { formatDate } from '../../core/format/time';
import type { ChartSelection } from './overlays';
import type { ChartCacheState } from './use-cache';
export type ChartStatusInput = {
  chartSelection: ChartSelection; chartCacheState: ChartCacheState; activeChartTitle: string; activeChartCount: number;
  savedEditions: readonly { revision: string; title: string }[]; savedEditionDetails: string; routingRevision: string;
};
export function ChartStatus({ chartSelection, chartCacheState, activeChartTitle, activeChartCount,
  savedEditions, savedEditionDetails, routingRevision }: ChartStatusInput) {
  return <div className="map-badge" aria-label="Chart status">
    <span>{chartSelection.base ? chartCacheState === 'preparing' ? 'CACHE'
      : chartCacheState === 'ready' ? 'MBTILES' : 'OFFLINE' : 'WEBGL'}</span>
    <strong>{chartSelection.base && chartCacheState === 'preparing' ? 'Preparing whole-file chart cache…'
      : chartSelection.base && chartCacheState === 'unavailable' ? 'Whole-file chart cache unavailable'
      : chartSelection.base ? `${activeChartTitle} · ${activeChartCount} charts` : 'Base map'}</strong>
    {savedEditions.length > 0 && <div className="saved-editions" role="status" title={savedEditionDetails} aria-label={savedEditionDetails}>
      {savedEditions.map(({ revision, title }) => <div key={revision}>{title} · Saved · <time dateTime={revision}>{formatDate(revision)}</time></div>)}
      {savedEditions.length > 1 && <div>Routes · <time dateTime={routingRevision}>{formatDate(routingRevision)}</time></div>}
    </div>}
  </div>;
}
