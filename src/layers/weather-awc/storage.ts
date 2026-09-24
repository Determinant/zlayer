import { createPluginStorage } from '../../core/storage/plugin-storage';
export const FORECAST_CACHE_BYTES = 256 * 1024 * 1024;
export const pluginStorage = createPluginStorage('weather-awc', undefined, {
  maxRecordBytes: 4 * 1024 * 1024,
  fileBudget: { maxEntries: 96, maxBytes: FORECAST_CACHE_BYTES, maxUnusedMs: 48 * 3600000,
    legacyCaches: { 'zlayers-awc-grids-v1': 16 * 1024 * 1024 } },
});
