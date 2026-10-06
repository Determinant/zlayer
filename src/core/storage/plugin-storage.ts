import { isRecord } from '@zlayer/contracts';
import type { PersistentRecord } from './record';
import { createPluginFileCache, type PluginFilePolicy, type PluginFileBudget } from './plugin-file-cache';
import { subscribePluginFileChanges } from './plugin-file-events';
import { optionalStorage } from './optional-storage';

export type PluginRecord<T> = PersistentRecord<T> & {
  /** All concurrent writers must use this locked read/change/write path. */
  update(change: (value: T) => T, signal?: AbortSignal): Promise<boolean>;
};

type RecordOptions<T> = {
  version: number;
  fallback: T;
  /** Validates/migrates parsed JSON on restore and before writes; must not write storage. */
  decode(value: unknown): T | undefined;
  encode(value: T): unknown;
  /** Read-only compatibility source. New writes always use the plugin namespace. */
  legacyKey?: string;
};
export type RecordStorage = Pick<Storage, 'getItem' | 'setItem'>;
type UiRetention = { prefix: string; limit: number };

/** Trusted plugins receive a separate key space; local names never select another owner. */
export function createPluginStorage(pluginId: string, legacyUi?: (name: string) => string | undefined,
  options: { fileBudget?: PluginFileBudget; maxRecordBytes?: number; uiRetention?: UiRetention[] } = {}) {
  if (!/^[a-z][a-z0-9-]*$/.test(pluginId)) throw new Error(`Invalid plugin storage identity: ${pluginId}`);
  if (options.maxRecordBytes !== undefined && (!Number.isSafeInteger(options.maxRecordBytes) || options.maxRecordBytes <= 0)) {
    throw new Error('Invalid plugin record limit');
  }
  const fits = (value: string) => options.maxRecordBytes === undefined || value.length * 2 <= options.maxRecordBytes;
  for (const rule of options.uiRetention ?? []) {
    if (!rule.prefix || !Number.isSafeInteger(rule.limit) || rule.limit < 1) throw new Error('Invalid UI retention limit');
  }
  const trimmed = new Set<UiRetention>();
  const retention = (name: string) => options.uiRetention?.find(rule => name.startsWith(rule.prefix));
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
  function record<T>(name: string, options: RecordOptions<T>): PluginRecord<T> {
    const stored = slot(name), { key } = stored;
    function commit(value: T, storage: Storage): boolean {
      const raw = JSON.stringify(options.encode(value));
      // Validate what a later read actually sees (JSON can change values).
      // Rejected writes must preserve existing data and never trigger eviction.
      if (typeof raw !== 'string' || !fits(raw) || options.decode(JSON.parse(raw)) === undefined) return false;
      const rule = retention(name);
      const prune = rule && (!trimmed.has(rule) || storage.getItem(key) === null);
      stored.write(raw, storage);
      if (prune) {
        pruneUi(storage, pluginId, rule, name, legacyUi);
        trimmed.add(rule);
      }
      return true;
    }
    const write = (value: T) => {
      try { commit(value, browserStorage()); }
      catch { /* Optional persistence must not disable session controls. */ }
    };
    function restore(storage: Storage, migrate: boolean): T {
      // Access errors must reach update(): an unavailable read is not an empty record.
      let raw = storage.getItem(key);
      const legacy = raw === null && options.legacyKey !== undefined;
      if (legacy) raw = storage.getItem(options.legacyKey!);
      if (raw === null || !fits(raw)) return options.fallback;
      let saved: unknown;
      try { saved = JSON.parse(raw); } catch { return options.fallback; }
      const value = options.decode(saved);
      if (value === undefined) return options.fallback;
      // Only explicit older envelopes or legacy keys establish a migration.
      // Codecs without a version field must not rewrite shared snapshots on reads.
      if (migrate && (legacy || (isRecord(saved) && saved.version !== undefined && saved.version !== options.version))) write(value);
      return value;
    }
    return { key, version: options.version, write,
      read() {
        try { return restore(browserStorage(), true); } catch { return options.fallback; }
      },
      async update(change, signal = new AbortController().signal) {
        try {
          const locks = globalThis.navigator?.locks;
          if (!locks) return false;
          return await optionalStorage(storageSignal => locks.request(key, { signal: storageSignal }, () => {
            storageSignal.throwIfAborted();
            const storage = browserStorage(), value = change(restore(storage, false));
            storageSignal.throwIfAborted();
            return commit(value, storage);
          }), signal);
        } catch { return false; }
      },
    };
  }
  return {
    pluginId,
    /** Optional bounded offline browsing files; product validity remains with the plugin. */
    files: (name: string, policy: PluginFilePolicy) => createPluginFileCache(pluginId, name, policy, options.fileBudget),
    subscribeFiles: (listener: () => void) => subscribePluginFileChanges(pluginId, listener),
    /** For coordinated saves/caches with an existing format; failures reach the owner. */
    slot,
    record,
    ui<T>(name: string, fallback: T, valid: (value: unknown) => value is T): PersistentRecord<T> {
      const legacyKey = legacyUi?.(name);
      return record(name, { version: 1, fallback,
        decode: saved => isRecord(saved) && saved.version === 1 && valid(saved.value) ? saved.value : undefined,
        encode: value => ({ version: 1, value: value ?? null,
          ...(retention(name) ? { updatedAt: Date.now() } : {}) }),
        ...(legacyKey === undefined ? {} : { legacyKey }),
      });
    },
  };
}

/** Optional view state only. Prune on first write/new identity, never on every
 * scroll update. Include old UI keys so evicted preferences cannot resurrect. */
function pruneUi(storage: Storage, pluginId: string, rule: UiRetention, current: string,
  legacyUi?: (name: string) => string | undefined): void {
  const prefix = `zlayer-plugin:${pluginId}:`;
  const entries = new Map<string, { keys: string[]; time: number }>();
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)!;
    const name = key.startsWith(prefix) ? key.slice(prefix.length)
      : key.startsWith('zlayer-ui:') ? key.slice('zlayer-ui:'.length) : '';
    if (!name.startsWith(rule.prefix) || key !== prefix + name && key !== legacyUi?.(name)) continue;
    let time = 0;
    try {
      const saved: unknown = JSON.parse(storage.getItem(key) ?? 'null');
      if (isRecord(saved) && typeof saved.updatedAt === 'number' && Number.isFinite(saved.updatedAt)) time = saved.updatedAt;
    } catch { /* Corrupt view state is eligible for ordinary eviction. */ }
    const entry = entries.get(name) ?? { keys: [], time: 0 };
    entry.keys.push(key); entry.time = Math.max(entry.time, time);
    entries.set(name, entry);
  }
  const ordered = [...entries].sort(([a, x], [b, y]) => Number(b === current) - Number(a === current) || y.time - x.time || a.localeCompare(b));
  for (const [, entry] of ordered.slice(rule.limit)) for (const key of entry.keys) storage.removeItem(key);
  // A successfully migrated value no longer needs its duplicate legacy slot.
  for (const [name, entry] of ordered.slice(0, rule.limit)) {
    if (entry.keys.includes(prefix + name)) for (const key of entry.keys) if (key !== prefix + name) storage.removeItem(key);
  }
}

export type PluginStorage = ReturnType<typeof createPluginStorage>;

function browserStorage(): Storage {
  return typeof window === 'undefined' ? globalThis.localStorage : window.localStorage;
}
