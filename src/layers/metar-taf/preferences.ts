import { pluginStorage } from './storage';
import { booleanPreference, pluginPreferences } from '../../core/storage/preferences';
export const metarPreferences = pluginPreferences(pluginStorage, saved => ({ metarEnabled: booleanPreference(saved.metarEnabled, true) }), 'zlayers-map-preferences-v1');
