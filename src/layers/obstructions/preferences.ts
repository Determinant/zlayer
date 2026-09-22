import { pluginStorage } from './storage';
import { booleanPreference, pluginPreferences } from '../../core/storage/preferences';
export const obstructionPreferences = pluginPreferences(pluginStorage, saved => ({ obstructionsEnabled: booleanPreference(saved.obstructionsEnabled, true) }), 'zlayers-map-preferences-v1');
