import { pluginStorage } from './storage';
import { CHART_BASES, CHART_OVERLAYS, type ChartBaseSelection, type ChartOverlaySelection } from './overlays';
import { pluginPreferences } from '../../core/storage/preferences';
export const chartPreferences = pluginPreferences<{ chartBase: ChartBaseSelection | undefined; chartOverlay: ChartOverlaySelection }>(pluginStorage, saved => {
  // Preserve the original single-family migration and explicit basemap choice.
  const legacyBase = saved.chartOverlay === '' ? ''
    : CHART_BASES.find(base => base.id === saved.chartOverlay)?.id
      ?? CHART_OVERLAYS.find(overlay => overlay.id === saved.chartOverlay)?.requires;
  const base = saved.chartBase === undefined && saved.version !== 2 ? legacyBase : saved.chartBase;
  return { chartBase: base === '' ? '' : CHART_BASES.find(item => item.id === base)?.id,
    chartOverlay: CHART_OVERLAYS.find(item => item.id === saved.chartOverlay)?.id ?? '' };
}, 'zlayers-map-preferences-v1');
