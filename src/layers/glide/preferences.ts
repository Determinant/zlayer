import { booleanPreference, pluginPreferences } from '../../core/storage/preferences';
import { createPluginStorage } from '../../core/storage/plugin-storage';
export const pluginStorage = createPluginStorage('glide');
export const DEFAULT_GLIDE_RATIO = 8;
export const MAX_GLIDE_ALTITUDE = 18000;
export type GlidePreferences = { glideEnabled: boolean; glideRatio: number; glideAltitude: number };
export const glidePreferences = pluginPreferences<GlidePreferences>(pluginStorage, saved => ({
  glideEnabled: booleanPreference(saved.glideEnabled, false),
  glideRatio: typeof saved.glideRatio === 'number' && Number.isFinite(saved.glideRatio) && saved.glideRatio >= 3 && saved.glideRatio <= 20
    ? Math.round(saved.glideRatio * 10) / 10 : DEFAULT_GLIDE_RATIO,
  glideAltitude: typeof saved.glideAltitude === 'number' && Number.isFinite(saved.glideAltitude) && saved.glideAltitude >= 0 && saved.glideAltitude <= MAX_GLIDE_ALTITUDE
    ? Math.round(saved.glideAltitude / 100) * 100 : 6500,
}));
