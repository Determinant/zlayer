import { pluginStorage } from './storage';
import { booleanPreference, pluginPreferences } from '../../core/storage/preferences';
export const ownshipPreferences = pluginPreferences(pluginStorage, saved => ({ ownshipEnabled: booleanPreference(saved.ownshipEnabled, true) }), 'zlayers-map-preferences-v1');
