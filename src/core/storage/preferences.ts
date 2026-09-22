import { isRecord } from '@zlayer/contracts';
import type { PersistentRecord } from './record';
import type { PluginStorage } from './plugin-storage';

/** Each plugin persists only its own preference fields. Composition stays in memory. */
export type PreferenceSlice<T extends object> = PersistentRecord<T> & { select(saved: Record<string, unknown>): T };
export function pluginPreferences<T extends object>(storage: PluginStorage, decode: (saved: Record<string, unknown>) => T,
  legacyKey?: string): PreferenceSlice<T> {
  return { ...storage.record('preferences', { version: 2, fallback: decode({}),
    ...(legacyKey === undefined ? {} : { legacyKey }),
    decode: saved => isRecord(saved) && (saved.version === undefined || saved.version === 1 || saved.version === 2)
      ? decode(saved) : undefined,
    encode: value => ({ version: 2, ...value }),
  }), select: saved => decode({ ...saved, version: 2 }) };
}
export function booleanPreference(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}
export function choice<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return options.find(option => option === value) ?? fallback;
}
