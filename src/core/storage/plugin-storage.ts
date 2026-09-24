import { isRecord } from '@zlayer/contracts';
import type { PersistentRecord } from './record';
import { createPluginFileCache, type PluginFilePolicy, type PluginFileBudget } from './plugin-file-cache';

type RecordOptions<T> = {
  version: number;
  fallback: T;
  decode(value: unknown): T | undefined;
  encode(value: T): unknown;
  /** Read-only compatibility source. New writes always use the plugin namespace. */
  legacyKey?: string;
};
export type RecordStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Trusted plugins receive a separate key space; local names never select another owner. */
export function createPluginStorage(pluginId: string, legacyUi?: (name: string) => string | undefined,
  options: { fileBudget?: PluginFileBudget; maxRecordBytes?: number } = {}) {
  if (!/^[a-z][a-z0-9-]*$/.test(pluginId)) throw new Error(`Invalid plugin storage identity: ${pluginId}`);
  if (options.maxRecordBytes !== undefined && (!Number.isSafeInteger(options.maxRecordBytes) || options.maxRecordBytes <= 0)) {
    throw new Error('Invalid plugin record limit');
  }
  const fits = (value: string) => options.maxRecordBytes === undefined || value.length * 2 <= options.maxRecordBytes;
  function slot(name: string, legacyKey?: string) {
    if (!name) throw new Error('A plugin record needs a local name');
    const key = `zlayer-plugin:${pluginId}:${name}`;
    return { key,
      read(storage: RecordStorage = browserStorage()): string | null {
        let raw = storage.getItem(key);
        if (raw === null && legacyKey !== undefined) raw = storage.getItem(legacyKey);
        return raw === null || fits(raw) ? raw : null;
      },
      write(value: string, storage: RecordStorage = browserStorage()): void {
        if (!fits(value)) throw new Error('Plugin record exceeds its storage limit');
        storage.setItem(key, value);
      },
    };
  }
  function record<T>(name: string, options: RecordOptions<T>): PersistentRecord<T> {
    const stored = slot(name), { key } = stored;
    const write = (value: T) => {
      try { stored.write(JSON.stringify(options.encode(value))); }
      catch { /* Optional persistence must not disable session controls. */ }
    };
    return { key, version: options.version, write, read() {
      try {
        const storage = browserStorage();
        let raw = storage.getItem(key);
        const legacy = raw === null && options.legacyKey !== undefined;
        if (legacy) raw = storage.getItem(options.legacyKey!);
        if (raw === null || !fits(raw)) return options.fallback;
        const saved: unknown = JSON.parse(raw);
        const value = options.decode(saved);
        if (value === undefined) return options.fallback;
        // Commit known migrations only. Unknown/corrupt records never fall back
        // to an older slot or get overwritten with defaults during startup.
        if (legacy || (isRecord(saved) && saved.version !== options.version)) write(value);
        return value;
      } catch { return options.fallback; }
    } };
  }
  return {
    pluginId,
    /** Optional bounded offline browsing files; product validity remains with the plugin. */
    files: (name: string, policy: PluginFilePolicy) => createPluginFileCache(pluginId, name, policy, options.fileBudget),
    /** For coordinated saves/caches with an existing format; failures reach the owner. */
    slot,
    record,
    ui<T>(name: string, fallback: T, valid: (value: unknown) => value is T): PersistentRecord<T> {
      const legacyKey = legacyUi?.(name);
      return record(name, { version: 1, fallback,
        decode: saved => isRecord(saved) && saved.version === 1 && valid(saved.value) ? saved.value : undefined,
        encode: value => ({ version: 1, value: value ?? null }),
        ...(legacyKey === undefined ? {} : { legacyKey }),
      });
    },
  };
}

export type PluginStorage = ReturnType<typeof createPluginStorage>;

function browserStorage(): Storage {
  return typeof window === 'undefined' ? globalThis.localStorage : window.localStorage;
}
