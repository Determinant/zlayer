import { useStoredState } from '../core/ui/use-persistent-state';
import type { LayerPlugin } from '../core/layers/plugin';
import type { PreferenceSlice } from '../core/storage/preferences';

type PreferenceValue<Plugin> = Plugin extends { preferences: PreferenceSlice<infer Value> } ? Value : never;
type Intersection<Value> = (Value extends unknown ? (value: Value) => void : never) extends (value: infer Combined) => void ? Combined : never;
type MapPreferences<Plugins extends readonly LayerPlugin[]> = Intersection<PreferenceValue<Plugins[number]>> & object;

/** The registration list is fixed for this workspace's lifetime. Include disabled
 * plugins so their choices survive; infer the UI value from those same owners. */
export function useMapPreferences<Plugins extends readonly LayerPlugin[]>(plugins: Plugins) {
  return useStoredState('workspace-map-preferences',
    () => readPreferences(plugins),
    (preferences, previous) => {
      for (const plugin of plugins) if (plugin.preferences) saveChangedPreference(plugin.preferences, preferences, previous);
    });
}
function saveChangedPreference(slice: PreferenceSlice<object>, preferences: object, previous: object) {
  const next = slice.select({ ...preferences });
  // Project the combined UI value into the owner's fields before comparing/writing.
  if (JSON.stringify(next) !== JSON.stringify(slice.select({ ...previous }))) slice.write(next);
}

function readPreferences<Plugins extends readonly LayerPlugin[]>(plugins: Plugins): MapPreferences<Plugins> {
  const fields = new Map<string, unknown>();
  const owners = new Map<string, string>();
  for (const plugin of plugins) {
    if (!plugin.preferences) continue;
    for (const [field, value] of Object.entries(plugin.preferences.read())) {
      const owner = owners.get(field);
      if (owner !== undefined) throw new Error(`Duplicate map preference ${field}: ${owner} and ${plugin.definition.id}`);
      owners.set(field, plugin.definition.id);
      fields.set(field, value);
    }
  }
  // The runtime collision check and inferred owner intersection describe the
  // same composition; Object.fromEntries itself cannot preserve that type.
  return Object.fromEntries(fields) as MapPreferences<Plugins>;
}
