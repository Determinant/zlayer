import { AWC_GRID_MODES } from '@zlayer/contracts';
import { booleanPreference, choice, pluginPreferences } from '../../core/storage/preferences';
import { pluginStorage } from './storage';
import { restoredWindAltitude } from './grids/wind-levels';

export const weatherAwcPreferences = pluginPreferences(pluginStorage, saved => ({
  awcGridMode: choice(saved.awcGridMode, AWC_GRID_MODES, 'none'),
  awcWindBarbs: booleanPreference(saved.awcWindBarbs, false),
  awcWindAltitude: restoredWindAltitude(saved),
  awcGridAltitude: typeof saved.awcGridAltitude === 'number' && Number.isInteger(saved.awcGridAltitude) && saved.awcGridAltitude >= 500 && saved.awcGridAltitude <= 30000 && saved.awcGridAltitude % 500 === 0 ? saved.awcGridAltitude : 8000,
  awcGridOpacity: typeof saved.awcGridOpacity === 'number' && Number.isFinite(saved.awcGridOpacity) ? Math.max(0.15, Math.min(0.85, saved.awcGridOpacity)) : 0.7,
  awcSldOverlay: booleanPreference(saved.awcSldOverlay, true),
  awcEnabled: booleanPreference(saved.awcEnabled, false),
  awcRadar: booleanPreference(saved.awcRadar, false),
  awcRadarMotion: booleanPreference(saved.awcRadarMotion, false),
  awcProgs: booleanPreference(saved.awcProgs, false),
  awcProgsIsobars: booleanPreference(saved.awcProgsIsobars, true),
  awcGairmet: booleanPreference(saved.awcGairmet, true),
  awcSigmet: booleanPreference(saved.awcSigmet, true),
  awcConvective: booleanPreference(saved.awcConvective, true),
  awcCwa: booleanPreference(saved.awcCwa, true),
  awcFreezing: booleanPreference(saved.awcFreezing, false),
  awcIcing: booleanPreference(saved.awcIcing, true),
  awcTurbulence: booleanPreference(saved.awcTurbulence, true),
  awcIfr: booleanPreference(saved.awcIfr, true),
  awcMountain: booleanPreference(saved.awcMountain, true),
  awcWind: booleanPreference(saved.awcWind, true),
}));
export type WeatherAwcPreferences = ReturnType<typeof weatherAwcPreferences.read>;
