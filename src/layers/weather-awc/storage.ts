import { createPluginStorage } from '../../core/storage/plugin-storage';
// One complete F00–F18 timeline fits even at the 16 MiB per-file ceiling.
export const FORECAST_CACHE_BYTES = 19 * 16 * 1024 * 1024;
const forecast = (hours: number) => ({ maxEntries: hours, maxBytes: hours * 16 * 1024 * 1024, maxUnusedMs: 48 * 3600000 });
export const pluginStorage = createPluginStorage('weather-awc', undefined, {
  maxRecordBytes: 4 * 1024 * 1024,
  // Inputs, images and unclassified compatibility files are disposable. Product
  // pools are additional ceilings, not reservations or upfront allocations.
  fileBudget: { maxEntries: 96, maxBytes: 256 * 1024 * 1024, maxUnusedMs: 48 * 3600000,
    groups: {
      clouds: forecast(19), icing: forecast(18), winds: forecast(19),
      progs: { maxEntries: 64, maxBytes: 32 * 1024 * 1024, maxUnusedMs: 48 * 3600000 },
      'progs-coverage': { maxEntries: 32, maxBytes: 8 * 1024 * 1024, maxUnusedMs: 48 * 3600000 },
      radar: { maxEntries: 24, maxBytes: 64 * 1024 * 1024, maxUnusedMs: 3600000 },
      'radar-motion': { maxEntries: 24, maxBytes: 16 * 1024 * 1024, maxUnusedMs: 3600000 },
    },
    legacyCaches: { 'zlayers-awc-grids-v1': 16 * 1024 * 1024 } },
});
