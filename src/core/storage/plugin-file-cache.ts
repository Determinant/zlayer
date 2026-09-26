import { withAbort } from '../data/abort';
import { InvalidDataError, resourceErrorCode } from '../data/errors';
import { transferFile } from './file-transfer';
import { discardResponseBody } from './response';
import type { TaskRunner } from '../data/task-limiter';
import { optionalStorage, StorageTimeoutError } from './optional-storage';
import { notifyPluginFileChange } from './plugin-file-events';

export type PluginFileResult<T> = { value: T; saved: boolean };
type FileRetention = { group: string; cohort?: string; keep?: readonly string[] };
type FileReference = { url: string; identity: string; byteLength?: number; signal: AbortSignal; retention?: FileRetention };

export type PluginFilePolicy = {
  maxEntries: number;
  maxBytes: number;
  maxFileBytes: number;
  maxUnusedMs: number;
  /** Read and validate pre-service files before migrating them on demand. */
  legacyCache?: string;
};
type FileLimits = Pick<PluginFilePolicy, 'maxEntries' | 'maxBytes' | 'maxUnusedMs'>;
/** The default pool and optional independent category pools share one publication lock. */
export type PluginFileBudget = FileLimits & {
  /** Named pools have separate ceilings and cannot evict one another. Limits are additive. */
  groups?: Readonly<Record<string, FileLimits>>;
  /** Older browsing caches owned by this plugin, with their original per-file ceiling. */
  legacyCaches?: Readonly<Record<string, number>>;
};
type FileRequest<T> = {
  url: string;
  /** Complete source/format identity, including digest and decoder version. */
  identity: string;
  /** Product-owned retention, independent of immutable file identity. Files in
   * this cohort cannot evict one another, including on quota recovery. */
  retention?: FileRetention;
  byteLength: number;
  label: string;
  validate(bytes: ArrayBuffer, signal: AbortSignal): Promise<T>;
  /** Validated data is usable before optional encoding/publication finishes.
   * The returned promise still owns cancellation, admission and the save receipt. */
  onReady?: (value: T) => void;
  signal: AbortSignal;
  cacheOnly?: boolean;
  retries?: number;
  /** Optional shared admission for a product's expensive decode/conversion work. */
  run?: TaskRunner;
};
type DerivedRequest<T> = Omit<FileRequest<T>, 'byteLength' | 'retries'> & {
  byteLength?: never;
  /** Runs only on a miss, inside the shared resource lock. Use core acquisition for inputs.
   * Return { value } for an already validated result too large to serialize/save. */
  create(signal: AbortSignal, ready: (value: T) => void): Promise<ArrayBuffer | { value: T }>;
  /** On-demand migration; validators must authenticate the old source/format. */
  legacy?: readonly { cache: string; key: string; convert(response: Response, signal: AbortSignal, ready: (value: T) => void): Promise<ArrayBuffer | { value: T }> }[];
};
type CacheRequest<T> = FileRequest<T> | DerivedRequest<T>;
type Stores = { name: string; files: Cache; access: Cache | undefined };
type Entry = { stores: Stores; key: Request; bytes: number; used: number; sequence: number; group: string | undefined; cohort: string | undefined };
type MigrationSource = { cache: string; key: string };
type Pending = { controller: AbortController; users: number; result: Promise<unknown>;
  ready?: { value: unknown }; listeners: Set<(value: unknown) => void> };
const pending = new Map<string, Pending>();
const USED = 'x-zlayer-last-used';
const VERSION = 'x-zlayer-file-version';
const DIGEST = 'x-zlayer-file-sha256';
const SEQUENCE = 'x-zlayer-access-sequence';
const GROUP = 'x-zlayer-retention-group';
const COHORT = 'x-zlayer-retention-cohort';
async function digest(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
}

/** Bounded immutable files for on-demand browsing, not explicit offline packs.
 * Decoded values are shared only while a request is in flight, never retained. */
export function createPluginFileCache(pluginId: string, name: string, policy: PluginFilePolicy, budget?: PluginFileBudget) {
  if (![pluginId, name].every(value => /^[a-z][a-z0-9-]*$/.test(value))) throw new Error('Invalid plugin file cache name');
  if (![policy.maxEntries, policy.maxBytes, policy.maxFileBytes, policy.maxUnusedMs].every(value => Number.isSafeInteger(value) && value > 0)
    || policy.maxFileBytes > policy.maxBytes) throw new Error('Invalid plugin file cache limits');
  if (budget && (![budget.maxEntries, budget.maxBytes, budget.maxUnusedMs, ...Object.values(budget.legacyCaches ?? {})]
    .every(value => Number.isSafeInteger(value) && value > 0) || policy.maxFileBytes > budget.maxBytes)) {
    throw new Error('Invalid plugin file budget');
  }
  for (const [group, limits] of Object.entries(budget?.groups ?? {})) {
    if (!/^[a-z][a-z0-9-]*$/.test(group) || ![limits.maxEntries, limits.maxBytes, limits.maxUnusedMs]
      .every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Invalid plugin file group');
  }
  const groupLimits = (group: string | undefined) => group !== undefined && budget?.groups && Object.hasOwn(budget.groups, group)
    ? budget.groups[group] : undefined;
  const prefix = `zlayers-plugin-files-v1:${pluginId}:`;
  const cacheName = `${prefix}${name}`;
  const publicationLock = `${prefix}publication`;

  async function open(signal: AbortSignal): Promise<Stores | undefined> {
    const openCache = async (name: string) => {
      try { return await optionalStorage(async () => globalThis.caches?.open(name), signal); }
      catch { signal.throwIfAborted(); return undefined; }
    };
    const [files, access] = await Promise.all([openCache(cacheName), openCache(`${cacheName}:access`)]);
    // Failed receipt storage must not make existing offline payloads unreadable.
    return files ? { name: cacheName, files, access } : undefined;
  }

  async function inventory(stores: Stores, signal: AbortSignal) {
    const now = Date.now(), result: Entry[] = [];
    // Access responses have no bodies. Batch their headers instead of one IPC
    // round trip per saved file; all callers hold the publication lock.
    const [files, keys, receipts] = await Promise.all([stores.files.keys(), stores.access?.keys() ?? [], stores.access?.matchAll() ?? []]);
    const metadataByKey = new Map(keys.map((key, i) => [key.url, receipts[i]!]));
    const order = new Map(keys.map((key, i) => [key.url, i]));
    for (const key of files) {
      signal.throwIfAborted();
      const metadata = metadataByKey.get(key.url);
      const file = metadata ? undefined : await stores.files.match(key);
      const limit = stores.name === cacheName ? policy.maxFileBytes : budget!.legacyCaches?.[stores.name] ?? budget!.maxBytes;
      // Old bounded caches may lack length headers. Charge their entire original
      // per-file allowance; never materialize their bodies just to count storage.
      const bytes = Number((metadata ?? file)?.headers.get('content-length')) || (!stores.access ? limit : 0);
      const timestamp = Number((metadata ?? file)?.headers.get(USED));
      const sequence = Number(metadata?.headers.get(SEQUENCE));
      const group = (metadata ?? file)?.headers.get(GROUP) ?? undefined;
      const cohort = (metadata ?? file)?.headers.get(COHORT) ?? undefined;
      discardResponseBody(metadata); discardResponseBody(file);
      if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > limit) {
        await remove(stores, key, signal); continue;
      }
      // Missing metadata and clock rollback receive a fresh retention grace period.
      const used = timestamp > 0 && timestamp <= now ? timestamp : now;
      result.push({ stores, key, bytes, used, sequence: Number.isSafeInteger(sequence) && sequence > 0 ? sequence : 0, group, cohort });
    }
    const present = new Set(result.map(entry => entry.key.url));
    for (const key of keys) if (!present.has(key.url)) { signal.throwIfAborted(); await stores.access?.delete(key); }
    return result.sort((a, b) => (order.get(a.key.url) ?? -1) - (order.get(b.key.url) ?? -1));
  }
  async function remove(stores: Stores, key: RequestInfo, signal: AbortSignal) {
    signal.throwIfAborted();
    if (await stores.files.delete(key)) notifyPluginFileChange(pluginId);
    signal.throwIfAborted();
    await stores.access?.delete(key);
  }
  const retentionHeaders = (retention?: FileRetention) => retention
    ? { [GROUP]: retention.group, ...(retention.cohort ? { [COHORT]: retention.cohort } : {}) } : {};
  async function touch(stores: Stores, key: string, bytes: number, sequence: number, signal: AbortSignal, retention?: FileRetention) {
    // Reorder only the tiny receipt, not the file. Works even when wall-clock
    // timestamps tie or roll back, and publication's lock orders other windows.
    signal.throwIfAborted();
    await stores.access!.delete(key);
    signal.throwIfAborted();
    await stores.access!.put(key, new Response(null, { headers: {
      'content-length': String(bytes), [USED]: String(Date.now()), [SEQUENCE]: String(sequence),
      ...retentionHeaders(retention),
    } }));
  }
  async function prune(stores: Stores, key: string, bytes: number, signal: AbortSignal, retention?: FileRetention, protectedLegacy?: MigrationSource) {
    const entries = await inventory(stores, signal);
    if (budget) {
      // Include dormant namespaces from previous versions/source configurations.
      for (const name of await caches.keys()) {
        signal.throwIfAborted();
        if (name === cacheName || !(name.startsWith(prefix) && !name.endsWith(':access') || budget.legacyCaches?.[name])) continue;
        const files = await caches.open(name);
        const access = name.startsWith(prefix) ? await caches.open(`${name}:access`) : undefined;
        entries.push(...await inventory({ name, files, access }, signal));
      }
      // The shared publication lock orders accesses across windows without
      // depending on wall-clock monotonicity. Old receipts sort before new ones.
      entries.sort((a, b) => a.sequence - b.sequence);
    }
    const sequence = entries.reduce((max, entry) => Math.max(max, entry.sequence), 0) + 1;
    const limits = retention ? groupLimits(retention.group)! : budget;
    const keep = new Set(retention?.keep);
    const protectedFile = (entry: Entry) => entry.stores.name === cacheName && keep.has(entry.key.url);
    // Unknown/older categories stay in the bounded default pool. A category's
    // reads, writes and quota recovery never remove another category's files.
    const others = entries.filter(entry => (entry.stores.name !== cacheName || entry.key.url !== key) &&
      (retention ? entry.group === retention.group : !groupLimits(entry.group)));
    let total = others.reduce((sum, entry) => sum + entry.bytes, bytes), count = others.length + 1;
    let localBytes = others.filter(entry => entry.stores.name === cacheName).reduce((sum, entry) => sum + entry.bytes, bytes);
    let localCount = others.filter(entry => entry.stores.name === cacheName).length + 1;
    const retained: Entry[] = [];
    for (const entry of others) {
      if (protectedLegacy && entry.stores.name === protectedLegacy.cache && entry.key.url === protectedLegacy.key) continue;
      if (protectedFile(entry) || retention?.cohort && entry.cohort === retention.cohort) continue;
      const local = entry.stores.name === cacheName;
      if (Date.now() - entry.used > (local ? Math.min(policy.maxUnusedMs, limits?.maxUnusedMs ?? Infinity) : limits!.maxUnusedMs)
        || local && (localBytes > policy.maxBytes || localCount > policy.maxEntries)
        || limits && (total > limits.maxBytes || count > limits.maxEntries)) {
        await remove(entry.stores, entry.key, signal); total -= entry.bytes; count--;
        if (local) { localBytes -= entry.bytes; localCount--; }
      } else retained.push(entry);
    }
    // A protected migration source stays intact if both copies cannot fit.
    if (localBytes > policy.maxBytes || localCount > policy.maxEntries ||
      limits && (total > limits.maxBytes || count > limits.maxEntries)) throw new Error('Plugin file budget exhausted');
    // Category saves may reclaim disposable/default files on actual browser
    // quota pressure, but no category is a victim of another category.
    const disposable = retention ? entries.filter(entry => !groupLimits(entry.group) &&
      (entry.stores.name !== cacheName || entry.key.url !== key) &&
      !protectedFile(entry) &&
      !(protectedLegacy && entry.stores.name === protectedLegacy.cache && entry.key.url === protectedLegacy.key)) : [];
    return { victims: [...disposable, ...retained], sequence };
  }

  async function acquire<T>(request: CacheRequest<T>, key: string, signal: AbortSignal, locks: LockManager | undefined, ready: (value: T) => void): Promise<PluginFileResult<T>> {
    signal.throwIfAborted();
    const stores = await open(signal);
    const publish = async (bytes: ArrayBuffer, protectedLegacy?: MigrationSource): Promise<boolean> => {
      if (!stores?.access || !locks) return false;
      try {
        const sha256 = 'create' in request ? await digest(bytes) : undefined;
        return await optionalStorage(storageSignal => locks.request(publicationLock, { signal: storageSignal }, async () => {
          storageSignal.throwIfAborted();
          const { victims, sequence } = await prune(stores, key, bytes.byteLength, storageSignal, request.retention, protectedLegacy);
          for (;;) {
            storageSignal.throwIfAborted();
            try {
              await stores.files.put(key, new Response(bytes, { headers: {
                'content-length': String(bytes.byteLength), [USED]: String(Date.now()), [VERSION]: crypto.randomUUID(),
                ...(sha256 ? { [DIGEST]: sha256 } : {}),
                ...retentionHeaders(request.retention),
              } }));
              notifyPluginFileChange(pluginId);
              await touch(stores, key, bytes.byteLength, sequence, storageSignal, request.retention);
              return true;
            } catch (error) {
              if (!(error instanceof DOMException && error.name === 'QuotaExceededError') || !victims.length) throw error;
              const victim = victims.shift()!;
              await remove(victim.stores, victim.key, storageSignal);
            }
          }
        }), signal);
      } catch { signal.throwIfAborted(); return false; }
    };
    const read = async (cache: Cache | undefined, savedKey: string, legacy = false): Promise<PluginFileResult<T> | undefined> => {
      let response: Response | undefined;
      let bodyRead = false;
      try {
        response = await optionalStorage(async () => cache?.match(savedKey), signal, discardResponseBody);
        if (!response) return undefined;
        const size = request.byteLength ?? Number(response.headers.get('content-length'));
        if (!Number.isSafeInteger(size) || size <= 0 || size > policy.maxFileBytes) throw new InvalidDataError('Invalid cached artifact size');
        const bytes = await optionalStorage(storageSignal => readBytes(response!, size, storageSignal, request.label), signal);
        bodyRead = true;
        if ('create' in request && await digest(bytes) !== response.headers.get(DIGEST)) throw new Error('Cached artifact checksum mismatch');
        const value = await request.validate(bytes, signal);
        signal.throwIfAborted();
        ready(value);
        let saved = true;
        if (legacy) {
          if (await publish(bytes, { cache: policy.legacyCache!, key: savedKey })) await optionalStorage(storageSignal => locks!.request(publicationLock,
            { signal: storageSignal }, () => { storageSignal.throwIfAborted(); return cache!.delete(savedKey); }), signal).catch(() => {});
        } else if (stores?.access && locks) {
          saved = await optionalStorage(storageSignal => locks.request(publicationLock, { signal: storageSignal }, async () => {
            // Another file's eviction may have removed this entry while it decoded.
            if (!(await stores.files.keys(key)).length) return false;
            const { sequence } = await prune(stores, key, bytes.byteLength, storageSignal, request.retention);
            await touch(stores, key, bytes.byteLength, sequence, storageSignal, request.retention);
            return true;
          }), signal).catch(() => false);
        } else {
          saved = await optionalStorage(async () => !!(await stores?.files.keys(key))?.length, signal).catch(() => false);
        }
        signal.throwIfAborted();
        return { value, saved };
      } catch (error) {
        signal.throwIfAborted();
        // A decoder worker crash says nothing about the integrity of saved bytes.
        if (resourceErrorCode(error) === 'worker') throw error;
        if (error instanceof StorageTimeoutError) { if (request.cacheOnly) throw error; return undefined; }
        // I/O failure is not proof of corruption. Preserve unreadable bytes for
        // a later retry; explicit length/response defects still invalidate them.
        if (!bodyRead && !(error instanceof InvalidDataError)) { if (request.cacheOnly) throw error; return undefined; }
        if (!legacy && response && stores && locks) await optionalStorage(storageSignal => locks.request(publicationLock, { signal: storageSignal }, async () => {
          const current = await stores.files.match(key);
          const same = current && current.headers.get(VERSION) === response!.headers.get(VERSION);
          discardResponseBody(current);
          // A cache-only reader can finish inspecting old corrupt bytes after
          // another window has repaired them. Never delete that replacement.
          if (same) await remove(stores, key, storageSignal);
        }), signal).catch(() => {});
        if (request.cacheOnly) throw error;
        return undefined;
      } finally { discardResponseBody(response); }
    };
    const cached = await read(stores?.files, key);
    if (cached !== undefined) return cached;
    if ('create' in request) for (const legacy of request.legacy ?? []) {
      let response: Response | undefined;
      try {
        const cache = await optionalStorage(async () => globalThis.caches?.open(legacy.cache), signal);
        response = await optionalStorage(async () => cache?.match(legacy.key), signal, discardResponseBody);
        if (!response) continue;
        const bytes = await legacy.convert(response, signal, ready);
        signal.throwIfAborted();
        if (!(bytes instanceof ArrayBuffer)) return { value: bytes.value, saved: false };
        const value = await request.validate(bytes, signal);
        ready(value);
        const saved = bytes.byteLength > 0 && bytes.byteLength <= policy.maxFileBytes && await publish(bytes, legacy);
        if (saved) await optionalStorage(storageSignal => locks!.request(publicationLock, { signal: storageSignal }, () => {
          storageSignal.throwIfAborted(); return cache!.delete(legacy.key);
        }), signal).catch(() => {});
        signal.throwIfAborted();
        return { value, saved };
      } catch { signal.throwIfAborted(); /* Keep old bytes until a replacement is saved. */ }
      finally { discardResponseBody(response); }
    }
    if (policy.legacyCache && !('create' in request)) {
      let legacy: Cache | undefined;
      try { legacy = await optionalStorage(async () => globalThis.caches?.open(policy.legacyCache!), signal); } catch { signal.throwIfAborted(); }
      const migrated = await read(legacy, request.url, true);
      if (migrated !== undefined) return migrated;
    }
    signal.throwIfAborted();
    if (request.cacheOnly) throw new Error(`${request.label} is not saved for offline use`);
    if ('create' in request) {
      const bytes = await request.create(signal, ready);
      signal.throwIfAborted();
      if (!(bytes instanceof ArrayBuffer)) return { value: bytes.value, saved: false };
      if (!bytes.byteLength || bytes.byteLength > policy.maxFileBytes) throw new Error(`${request.label} exceeds its file cache limits`);
      const value = await request.validate(bytes, signal);
      signal.throwIfAborted();
      ready(value);
      const saved = await publish(bytes);
      signal.throwIfAborted();
      return { value, saved };
    }
    return transferFile({ url: request.url, label: request.label, byteLength: request.byteLength, signal,
      retries: request.retries ?? 0 }, async ({ blob }) => {
      const bytes = await blob.arrayBuffer(); // Acquisition already enforced the declared bound.
      signal.throwIfAborted();
      const value = await request.validate(bytes, signal);
      signal.throwIfAborted();
      ready(value);
      const saved = await publish(bytes);
      signal.throwIfAborted();
      return { value, saved };
    });
  }

  function load<T>(request: CacheRequest<T>): Promise<PluginFileResult<T>> {
      request.signal.throwIfAborted();
      if (!request.identity || !('create' in request) && (!Number.isSafeInteger(request.byteLength) || request.byteLength <= 0 || request.byteLength > policy.maxFileBytes)) {
        throw new Error(`${request.label} exceeds its file cache limits`);
      }
      if (request.retention && (!groupLimits(request.retention.group) || request.retention.cohort !== undefined &&
        !/^[\x21-\x7e]{1,256}$/.test(request.retention.cohort))) throw new Error('Invalid plugin file retention');
      if (request.retention?.keep && (request.retention.keep.length > 256 || request.retention.keep.some(key => typeof key !== 'string' || !key))) {
        throw new Error('Invalid plugin file retention references');
      }
      const key = pluginFileKey(request);
      // Cache-only requests cannot join a network request or inherit its policy.
      const id = JSON.stringify([cacheName, key, !!request.cacheOnly, policy, budget, request.retention]);
      return share(id, request.signal, request.onReady, async (signal, ready) => {
        const admitted = (locks: LockManager | undefined) => request.run
          ? request.run(signal, () => acquire(request, key, signal, locks, ready)) : acquire(request, key, signal, locks, ready);
        let locks: LockManager | undefined;
        try { locks = globalThis.navigator?.locks; } catch { /* Optional storage coordination. */ }
        if (!locks || request.cacheOnly) return admitted(locks);
        let entered = false;
        try {
          // WebKit rejects lock names longer than 1024 characters. Keep the
          // complete source identity in storage, and coordinate by its digest.
          const resourceLock = `${cacheName}:resource:${await digest(new TextEncoder().encode(key).buffer)}`;
          signal.throwIfAborted();
          return await locks.request(resourceLock, { signal }, () => {
            entered = true;
            return admitted(locks);
          });
        } catch (error) {
          signal.throwIfAborted();
          if (entered) throw error;
          // Lock access can be denied independently of network/cache reads.
          return admitted(undefined);
        }
      });
  }
  return { cacheName,
    load: <T>(request: FileRequest<T>) => load(request).then(result => result.value),
    derive: <T>(request: DerivedRequest<T>) => load(request).then(result => result.value),
    loadResult: <T>(request: FileRequest<T>) => load(request),
    deriveResult: <T>(request: DerivedRequest<T>) => load(request),
    /** Reconcile previously authenticated receipts in one metadata-only read.
     * Presence does not replace content validation when a file is used. */
    async retained(requests: readonly Omit<FileReference, 'signal'>[], signal: AbortSignal): Promise<boolean[]> {
      signal.throwIfAborted();
      if (!requests.length) return [];
      try {
        const stores = await open(signal);
        const keys = await optionalStorage(async () => stores?.files.keys() ?? [], signal);
        const present = new Set(keys.map(key => key.url));
        return requests.map(request => present.has(pluginFileKey(request)));
      } catch { signal.throwIfAborted(); return requests.map(() => false); }
    },
    /** Cheap preparation inventory; content is still validated by load/derive before display. */
    async has(request: FileReference): Promise<boolean> {
      request.signal.throwIfAborted();
      let response: Response | undefined;
      let receipt: Response | undefined;
      try {
        const stores = await open(request.signal);
        response = await optionalStorage(async () => stores?.files.match(pluginFileKey(request)), request.signal, discardResponseBody);
        const size = Number(response?.headers.get('content-length'));
        const valid = response?.status === 200 && Number.isSafeInteger(size) && size > 0 && size <= policy.maxFileBytes &&
          (request.byteLength === undefined ? /^[a-f0-9]{64}$/.test(response.headers.get(DIGEST) ?? '') : size === request.byteLength);
        if (!valid || !request.retention) return valid;
        // Older files must pass a validated load before preparation can count
        // them under a new category/cohort. Never touch LRU or adopt on presence.
        receipt = await optionalStorage(async () => stores?.access?.match(pluginFileKey(request)), request.signal, discardResponseBody);
        const headers = (receipt ?? response)!.headers;
        return headers.get(GROUP) === request.retention.group &&
          (headers.get(COHORT) ?? undefined) === request.retention.cohort;
      } catch { request.signal.throwIfAborted(); return false; }
      finally { discardResponseBody(response); discardResponseBody(receipt); }
    },
  };
}

/** Exact previous identity for an explicit, source-aware migration. */
export function pluginFileKey(request: Pick<FileReference, 'url' | 'identity' | 'byteLength'>): string {
  const url = new URL(request.url);
  url.searchParams.append('zlayer-file-identity', JSON.stringify([request.identity, request.byteLength ?? 'derived']));
  return url.href;
}

/** Authenticate an older core-derived artifact before its product migrates it. */
export async function readDerivedArtifact(response: Response, maximumBytes: number, signal: AbortSignal): Promise<ArrayBuffer> {
  const size = Number(response.headers.get('content-length'));
  if (!Number.isSafeInteger(size) || size <= 0 || size > maximumBytes) throw new InvalidDataError('Invalid legacy artifact size');
  const bytes = await optionalStorage(storageSignal => readBytes(response, size, storageSignal, 'Legacy artifact'), signal);
  if (await digest(bytes) !== response.headers.get(DIGEST)) throw new InvalidDataError('Legacy artifact checksum mismatch');
  return bytes;
}

async function readBytes(response: Response, byteLength: number, signal: AbortSignal, label: string): Promise<ArrayBuffer> {
  if (response.status !== 200 || !response.body) throw new InvalidDataError(`${label} cache response is incomplete`);
  const reader = response.body.getReader(), bytes = new Uint8Array(byteLength);
  let offset = 0;
  try {
    for (;;) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      if (offset + value.length > byteLength) throw new InvalidDataError(`${label} cached file exceeds its byte limit`);
      bytes.set(value, offset); offset += value.length;
    }
    if (offset !== byteLength) throw new InvalidDataError(`${label} cached file size mismatch`);
    return bytes.buffer;
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function share<T>(key: string, signal: AbortSignal, onReady: ((value: T) => void) | undefined,
  work: (signal: AbortSignal, ready: (value: T) => void) => Promise<PluginFileResult<T>>): Promise<PluginFileResult<T>> {
  let task = pending.get(key);
  if (!task) {
    const controller = new AbortController();
    const current: Pending = { controller, users: 0, listeners: new Set(), result: Promise.resolve().then(() => work(controller.signal, value => {
      if (controller.signal.aborted || current.ready) return;
      current.ready = { value };
      for (const listener of current.listeners) listener(value);
    })) };
    task = current; pending.set(key, task);
    void task.result.finally(() => { if (pending.get(key) === current) pending.delete(key); }).catch(() => {});
  }
  task.users++;
  // A failed observer cannot invalidate authenticated bytes or another caller's save.
  const listener = (value: unknown) => { if (!signal.aborted) { try { onReady?.(value as T); } catch { /* Observer only. */ } } };
  task.listeners.add(listener);
  if (task.ready) listener(task.ready.value);
  try { return await withAbort(task.result as Promise<PluginFileResult<T>>, signal); }
  finally {
    task.listeners.delete(listener);
    if (--task.users === 0) {
      if (pending.get(key) === task) pending.delete(key);
      task.controller.abort();
    }
  }
}
