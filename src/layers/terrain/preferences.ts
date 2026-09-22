import { pluginStorage } from './storage';
import { MAX_TERRAIN_ALTITUDE, TERRAIN_ALTITUDE_STEP } from './clearance';
import type { TerrainCoverage } from './types';
import { booleanPreference, choice, pluginPreferences } from '../../core/storage/preferences';
export const terrainPreferences = pluginPreferences<{ terrainEnabled: boolean; terrainCoverage: TerrainCoverage; terrainAltitude: number | null }>(pluginStorage, saved => ({ terrainEnabled: booleanPreference(saved.terrainEnabled, true),
    terrainCoverage: choice(saved.terrainCoverage, ['route', 'viewport'], 'route'),
    terrainAltitude: typeof saved.terrainAltitude === 'number' && Number.isFinite(saved.terrainAltitude)
      && saved.terrainAltitude >= 0 && saved.terrainAltitude <= MAX_TERRAIN_ALTITUDE
      ? Math.round(saved.terrainAltitude / TERRAIN_ALTITUDE_STEP) * TERRAIN_ALTITUDE_STEP : null }), 'zlayers-map-preferences-v1');
