import { useStoredState } from '../core/ui/use-persistent-state';
import type { PreferenceSlice } from '../core/storage/preferences';
import { chartPreferences } from '../layers/charts/preferences';
import { navigationPreferences } from '../layers/navigation/preferences';
import { terrainPreferences } from '../layers/terrain/preferences';
import { ownshipPreferences } from '../layers/ownship/preferences';
import { obstructionPreferences } from '../layers/obstructions/preferences';
import { metarPreferences } from '../layers/metar-taf/preferences';

const slices = [chartPreferences, navigationPreferences, terrainPreferences, ownshipPreferences, obstructionPreferences, metarPreferences] as const;
type MapPreferences = ReturnType<typeof chartPreferences.read> & ReturnType<typeof navigationPreferences.read> & ReturnType<typeof terrainPreferences.read> & ReturnType<typeof ownshipPreferences.read> & ReturnType<typeof obstructionPreferences.read> & ReturnType<typeof metarPreferences.read>;
export function useMapPreferences() {
  return useStoredState('workspace-map-preferences', readPreferences, (preferences, previous) => {
    for (const slice of slices) saveChangedPreference(slice, preferences, previous);
  });
}
function saveChangedPreference(slice: PreferenceSlice<object>, preferences: MapPreferences, previous: MapPreferences) {
  const next = slice.select(preferences);
  // Project the combined UI value into the owner's fields before comparing/writing.
  if (JSON.stringify(next) !== JSON.stringify(slice.select(previous))) slice.write(next);
}
function readPreferences(): MapPreferences {
  return Object.assign({}, ...slices.map(slice => slice.read())) as MapPreferences;
}
