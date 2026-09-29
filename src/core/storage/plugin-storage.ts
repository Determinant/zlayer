import { isRecord } from '@zlayer/contracts';
import type { PersistentRecord } from './record';
import { createPluginFileCache, type PluginFilePolicy, type PluginFileBudget } from './plugin-file-cache';
import { subscribePluginFileChanges } from './plugin-file-events';

type RecordOptions<T> = {
  version: number;
  fallback: T;
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
  function record<T>(name: string, options: RecordOptions<T>): PersistentRecord<T> {
    const stored = slot(name), { key } = stored;
    const write = (value: T) => {
      try {
        const storage = browserStorage(), rule = retention(name);
        const prune = rule && (!trimmed.has(rule) || storage.getItem(key) === null);
        stored.write(JSON.stringify(options.encode(value)), storage);
        if (prune) {
          pruneUi(storage, pluginId, rule, name, legacyUi);
          trimmed.add(rule);
        }
      }
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
