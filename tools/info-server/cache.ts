import { mkdir, open, readdir, rename, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import { cacheProduct, HttpError, MiB, routeFor, type Resource } from './weather-resources.ts';
import { digest, type Payload } from './upstream.ts';
import { withAbort } from '../../src/core/data/abort';
import { DurationStats } from './metrics';
import { atomicStateFile, readStateJson } from './state-file';

export const DEFAULT_WEATHER_CACHE_BYTES = 8192 * MiB;
export const DEFAULT_WEATHER_CACHE_ENTRIES = 5000;

type Entry = Omit<Payload, 'body'> & { resource: Resource; product: string; bytes: number; offset: number; file: string; removed?: boolean;
  immutable: boolean; gzipBytes?: number; gzipHash?: string; verified?: boolean; verification?: Promise<void>; verificationStamp?: string };
type ProductStats = { entries: number; bytes: number; loads: number; loadFailures: number; expiredRemovals: number; capacityEvictions: number };
type Grace = { resources: Resource[]; milliseconds: number };
const MAX_GRACE_MS = 10 * 60_000, MAX_GRACE_BYTES = 16 * MiB;
const compress = promisify(gzip);
const storedBytes = (entry: Entry) => entry.bytes + (entry.gzipBytes ?? 0);
const preparedRoute = (resource: Resource) => resource.kind === 'prepared' && new URL(resource.url).origin === 'http://weather.invalid'
  ? routeFor(new URL(resource.url).pathname) : undefined;
type Options = { directory: string; maxBytes: number; maxEntries?: number;
  load: (resource: Resource, signal: AbortSignal) => Promise<Payload>; signal?: AbortSignal;
  now?: (() => number) | undefined; log?: (message: string) => void };

/** One atomic file per artifact, including negotiated encodings. Only metadata
 * stays in memory; refreshes share one promise. */
export class WeatherCache {
  private entries = new Map<string, Entry>();
  private pending = new Map<string, Promise<Payload>>();
  private failures = new Map<string, { until: number; error: HttpError; rejected?: string }>();
  private observers = new Map<string, Set<(payload: Payload) => void>>();
  private retained = new Set<string>();
  private publication: Promise<void> = Promise.resolve();
  private bytes = 0;
  private expiredRemovals = 0;
  private capacityEvictions = 0;
  private capacityTrims = 0;
  private deferPruning = false;
  private grace = new Map<string, number>();
  private readonly products = new Map<string, ProductStats>();
  private readonly publicationWait = new DurationStats();
  private lastExpirySweep: number | undefined;
  private options: Options;
  private readonly signal: AbortSignal;
  constructor(options: Options) { this.options = options; this.signal = options.signal ?? new AbortController().signal; }

  async restore(options: { deferPruning?: boolean } = {}): Promise<void> {
    this.deferPruning = options.deferPruning ?? false;
    await mkdir(this.options.directory, { recursive: true });
    for (const name of await readdir(this.options.directory)) {
      if (/^retention\.json\.[a-f0-9-]+\.tmp$/.test(name)) { await unlink(join(this.options.directory, name)).catch(() => {}); continue; }
      if (!/^[a-f0-9-]+\.(cache|tmp)$/.test(name)) continue;
      const file = join(this.options.directory, name);
      try {
        if (name.endsWith('.tmp')) throw new Error('Interrupted write');
        const handle = await open(file, 'r');
        let entry: Entry;
        try {
          const prefix = Buffer.alloc(4);
          if ((await handle.read(prefix, 0, 4, 0)).bytesRead !== 4) throw new Error('Truncated cache');
          const size = prefix.readUInt32BE();
          if (size > 16_384) throw new Error('Invalid metadata length');
          const metadata = Buffer.alloc(size);
          if ((await handle.read(metadata, 0, size, 4)).bytesRead !== size) throw new Error('Truncated metadata');
          entry = JSON.parse(metadata.toString('utf8')) as Entry;
          const stat = await handle.stat();
          const origin = new URL(entry.resource.url).origin;
          const route = preparedRoute(entry.resource), prepared = route?.resource.key === entry.resource.key;
          const immutable = prepared && route?.type === 'artifact';
          if (!(prepared || ['https://aviationweather.gov', 'https://nomads.ncep.noaa.gov', 'https://storage.googleapis.com', 'https://noaa-mrms-pds.s3.amazonaws.com', 'https://tgftp.nws.noaa.gov'].includes(origin) &&
            ['json', 'gairmet-cache', 'pirep-cache', 'index', 'model-metadata', 'range', 'surface', 'coverage-image', 'radar-index', 'radar-data'].includes(entry.resource.kind)) ||
            typeof entry.resource.key !== 'string' || !entry.resource.key ||
            !Number.isSafeInteger(entry.resource.ttl) || entry.resource.ttl <= 0 || entry.resource.ttl > 86_400_000 ||
            ![200, 206].includes(entry.status) || !entry.headers || typeof entry.headers !== 'object' || Array.isArray(entry.headers) ||
            !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > 16 * 1024 * 1024 ||
            !Number.isSafeInteger(entry.checkedAt) || entry.checkedAt < 0 || entry.checkedAt > (this.options.now ?? Date.now)() ||
            !immutable && (this.options.now ?? Date.now)() - entry.checkedAt >= entry.resource.ttl ||
            (entry.gzipBytes !== undefined && (!Number.isSafeInteger(entry.gzipBytes) || entry.gzipBytes <= 0 || entry.gzipBytes > entry.bytes ||
              !/^[a-f0-9]{64}$/.test(entry.gzipHash ?? ''))) ||
            stat.size !== size + 4 + storedBytes(entry) || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Expired or invalid cache');
          for (const [name, value] of Object.entries(entry.headers)) {
            if (typeof value !== 'string') throw new Error('Invalid cached response header');
            validateHeaderName(name); validateHeaderValue(name, value);
          }
          // Apply current artifact retention to older files without rewriting
          // their bytes or source timestamps. Owners restore protection first.
          if (immutable) entry.resource = route.resource;
          entry = { ...entry, product: cacheProduct(entry.resource), immutable, file, offset: size + 4, removed: false, verified: false };
          delete entry.verification;
          delete entry.verificationStamp;
        } finally { await handle.close(); }
        const previous = this.entries.get(entry.resource.key);
        if (previous && previous.checkedAt >= entry.checkedAt) { await unlink(file); continue; }
        if (previous) await this.remove(previous);
        this.entries.set(entry.resource.key, entry); this.account(entry, 1);
      } catch { await unlink(file).catch(() => {}); }
    }
    // Access order is maintained in the map after this one startup sort.
    this.entries = new Map([...this.entries].sort((a, b) => a[1].checkedAt - b[1].checkedAt));
    await this.restoreGrace();
    // Owners must restore references before either expiry or capacity cleanup,
    // including publications that repair a catalog during startup.
    await this.trim(0, 0, undefined, false);
  }

  /** Finish startup cleanup after catalog owners have retained their files. */
  async prune(): Promise<void> { this.deferPruning = false; await this.trim(); }

  get stats() { return { entries: this.entries.size, bytes: this.bytes, updating: this.pending.size,
    maxBytes: this.options.maxBytes, maxEntries: this.options.maxEntries ?? DEFAULT_WEATHER_CACHE_ENTRIES,
    expiredRemovals: this.expiredRemovals, capacityEvictions: this.capacityEvictions, capacityTrims: this.capacityTrims,
    products: Object.fromEntries([...this.products].map(([name, stats]) => [name, { ...stats }])), publicationWait: this.publicationWait.status }; }
  storedSize(resource: Resource): number { const entry = this.entries.get(resource.key); return entry ? storedBytes(entry) : 0; }

  private productStats(product: string): ProductStats {
    let stats = this.products.get(product);
    if (!stats) { stats = { entries: 0, bytes: 0, loads: 0, loadFailures: 0, expiredRemovals: 0, capacityEvictions: 0 }; this.products.set(product, stats); }
    return stats;
  }
  private account(entry: Entry, direction: 1 | -1): void {
    const bytes = direction * storedBytes(entry), stats = this.productStats(entry.product);
    this.bytes += bytes; stats.bytes += bytes; stats.entries += direction;
  }
  private touch(entry: Entry): void {
    if (this.entries.get(entry.resource.key) !== entry) return;
    this.entries.delete(entry.resource.key); this.entries.set(entry.resource.key, entry);
  }
  private fresh(checkedAt: number, maxAge: number): boolean {
    const age = (this.options.now ?? Date.now)() - checkedAt;
    return Number.isSafeInteger(checkedAt) && age >= 0 && age < maxAge;
  }
  assertFresh(resource: Resource, checkedAt: number): void {
    if (!this.fresh(checkedAt, resource.ttl)) throw new HttpError(503, 'Weather source timestamp is not current', 5);
  }

  /** Product summaries follow authenticated cache publications, regardless of
   * which reader initiated acquisition. Callbacks run in the publication turn. */
  observe(resource: Resource, published: (payload: Payload) => void, signal: AbortSignal): void {
    if (signal.aborted) return;
    const observers = this.observers.get(resource.key) ?? new Set();
    observers.add(published); this.observers.set(resource.key, observers);
    signal.addEventListener('abort', () => {
      observers.delete(published);
      if (!observers.size) this.observers.delete(resource.key);
    }, { once: true });
  }
  private observed(entry: Entry, payload: Payload): void {
    if (this.entries.get(entry.resource.key) !== entry) return;
    for (const published of this.observers.get(entry.resource.key) ?? []) {
      try { published(payload); }
      catch (cause) { this.options.log?.(`Cache publication observer failed: ${String(cause)}`); }
    }
  }
  isCurrent(resource: Resource, payload: Pick<Payload, 'checkedAt' | 'sha256'>): boolean {
    const entry = this.entries.get(resource.key);
    return this.has(resource) && entry?.checkedAt === payload.checkedAt && entry.sha256 === payload.sha256;
  }
  failure(resource: Resource): HttpError | undefined { return this.failures.get(resource.key)?.error; }

  /** Published and building generations cannot be evicted by disposable source reads. */
  private readonly retentions = new Map<string, Set<string>>();
  retain(keys: Iterable<string>, owner = 'grids') {
    this.retentions.set(owner, new Set(keys));
    this.retained = new Set([...this.retentions.values()].flatMap(keys => [...keys]));
  }

  private async restoreGrace(): Promise<void> {
    try {
      const value = await readStateJson(join(this.options.directory, 'retention.json'), MAX_GRACE_BYTES) as
        { schemaVersion?: unknown; writtenAt?: unknown; leases?: unknown } | null;
      if (!value || value.schemaVersion !== 1 || !Number.isSafeInteger(value.writtenAt) || Number(value.writtenAt) < 0 ||
        !Array.isArray(value.leases)) throw new Error('Invalid weather retention metadata');
      const now = (this.options.now ?? Date.now)(), restored = new Map<string, number>();
      for (const lease of value.leases) {
        if (!Array.isArray(lease) || lease.length !== 2 || typeof lease[0] !== 'string' || lease[0].length > 256 ||
          !Number.isSafeInteger(lease[1]) || lease[1] <= Number(value.writtenAt) || lease[1] > Number(value.writtenAt) + MAX_GRACE_MS) {
          throw new Error('Invalid weather retention lease');
        }
        if (lease[1] > now && this.entries.get(lease[0])?.immutable) restored.set(lease[0], Math.min(lease[1], now + MAX_GRACE_MS));
      }
      this.grace = restored;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') this.options.log?.(`Weather retention restore failed: ${String(cause)}`);
    }
  }

  /** Commit protection before replacing a catalog. A failed publication may
   * leave extra bounded grace, but a committed one never loses it on restart. */
  private async preserve(grace: Grace): Promise<void> {
    if (!Number.isSafeInteger(grace.milliseconds) || grace.milliseconds <= 0 || grace.milliseconds > MAX_GRACE_MS) throw new Error('Invalid weather retention duration');
    const now = (this.options.now ?? Date.now)();
    const next = new Map([...this.grace].filter(([key, until]) => until > now && this.entries.has(key))
      .map(([key, until]) => [key, Math.min(until, now + MAX_GRACE_MS)]));
    for (const resource of grace.resources) if (this.entries.get(resource.key)?.immutable && this.has(resource)) {
      next.set(resource.key, Math.max(next.get(resource.key) ?? 0, now + grace.milliseconds));
    }
    if (!next.size && !this.grace.size) return;
    const content = JSON.stringify({ schemaVersion: 1, writtenAt: now, leases: [...next] });
    if (Buffer.byteLength(content) > MAX_GRACE_BYTES) throw new Error('Weather retention metadata exceeds its size limit');
    await atomicStateFile(join(this.options.directory, 'retention.json'), content);
    this.grace = next;
  }

  async discard(resource: Resource): Promise<void> {
    const entry = this.entries.get(resource.key);
    if (entry) await this.remove(entry);
  }

  /** A transport-valid observation can still fail its owner's source contract.
   * Quarantine that exact observation, never a newer replacement. Consumers
   * share one retry deadline instead of repeatedly reusing rejected bytes. */
  reject(resource: Resource, payload: Pick<Payload, 'checkedAt' | 'sha256'>, error: HttpError): Promise<void> {
    const rejected = `${payload.checkedAt}:${payload.sha256}`;
    const task = this.publication.catch(() => {}).then(async () => {
      const entry = this.entries.get(resource.key);
      if (entry && (entry.checkedAt !== payload.checkedAt || entry.sha256 !== payload.sha256)) return;
      if (this.failures.get(resource.key)?.rejected === rejected) return;
      if (this.failures.size >= 5000) this.failures.delete(this.failures.keys().next().value!);
      this.failures.set(resource.key, { error, rejected,
        until: (this.options.now ?? Date.now)() + Math.max(5, error.retryAfter) * 1000 });
      if (entry) await this.remove(entry);
    });
    this.publication = task;
    return task;
  }

  /** After server shutdown, wait for outstanding reads/writes to release their files. */
  async drain(): Promise<void> { await Promise.allSettled([...this.pending.values(), this.publication]); }

  /** Source freshness or immutable artifact availability; reads authenticate bytes.
   * Artifact retention never changes the original source-check timestamp. */
  has(resource: Resource, maxAgeMs = resource.ttl): boolean {
    const entry = this.entries.get(resource.key);
    return !!entry && this.fresh(entry.checkedAt, entry.immutable ? Infinity : Math.min(resource.ttl, maxAgeMs));
  }

  async read(resource: Resource, maxAgeMs = resource.ttl): Promise<Payload | undefined> {
    if (!this.has(resource, maxAgeMs)) return undefined;
    // Stat and bound the file before allocating. Background consumers need only
    // the raw representation, not an extra copy of the saved gzip bytes.
    const saved = await this.open(resource, false, false);
    if (!saved) return undefined;
    const { entry, handle, offset, length } = saved;
    try {
      const body = Buffer.alloc(length);
      for (let at = 0; at < length;) {
        const { bytesRead } = await handle.read(body, at, length - at, offset + at);
        if (!bytesRead) throw new Error('Truncated cache body');
        at += bytesRead;
      }
      if (digest(body) !== entry.sha256) throw new Error('Damaged cache body');
      if (!this.fresh(entry.checkedAt, entry.immutable ? Infinity : Math.min(resource.ttl, maxAgeMs))) return undefined;
      const payload = { body, status: entry.status, headers: entry.headers, checkedAt: entry.checkedAt, sha256: entry.sha256 };
      this.observed(entry, payload);
      return payload;
    } catch {
      if (this.entries.get(resource.key) !== entry) return this.read(resource, maxAgeMs);
      await this.remove(entry); return undefined;
    } finally { await handle.close(); }
  }

  /** Authenticate an immutable file once after restart, with bounded read buffers.
   * Both HTTP encodings retain the original uncompressed artifact identity. */
  private async verify(entry: Entry, handle: FileHandle): Promise<void> {
    if (entry.verified) return;
    entry.verification ??= (async () => {
      const raw = createHash('sha256'), encoded = createHash('sha256'); let at = 0;
      if (storedBytes(entry)) for await (const chunk of handle.createReadStream({ start: entry.offset,
        end: entry.offset + storedBytes(entry) - 1, autoClose: false })) {
        const body = chunk as Buffer, split = Math.max(0, Math.min(body.length, entry.bytes - at));
        raw.update(body.subarray(0, split)); encoded.update(body.subarray(split)); at += body.length;
      }
      if (at !== storedBytes(entry) || raw.digest('hex') !== entry.sha256 ||
        entry.gzipBytes && encoded.digest('hex') !== entry.gzipHash) throw new Error('Damaged weather artifact');
      entry.verified = true;
    })();
    await entry.verification;
  }

  /** HTTP reads stream saved bytes; opening a cache entry never enters its producer. */
  async open(resource: Resource, gzipAccepted = false, verify = true): Promise<{ entry: Entry; handle: FileHandle; offset: number; length: number; gzip: boolean } | undefined> {
    const entry = this.has(resource) ? this.entries.get(resource.key) : undefined;
    if (!entry) return undefined;
    try {
      const handle = await open(entry.file, 'r');
      try {
        const stat = await handle.stat();
        if (stat.size !== entry.offset + storedBytes(entry)) throw new Error('Truncated forecast file');
        const stamp = `${stat.size}/${stat.mtimeMs}/${stat.ctimeMs}`;
        if (entry.verificationStamp !== stamp) {
          entry.verified = false; delete entry.verification; entry.verificationStamp = stamp;
        }
        if (verify) await this.verify(entry, handle);
      } catch (error) { await handle.close(); throw error; }
      if (!this.fresh(entry.checkedAt, entry.immutable ? Infinity : resource.ttl)) { await handle.close(); return undefined; }
      this.touch(entry);
      const gzip = gzipAccepted && !!entry.gzipBytes;
      return { entry, handle, gzip, offset: entry.offset + (gzip ? entry.bytes : 0), length: gzip ? entry.gzipBytes! : entry.bytes };
    } catch {
      if (this.entries.get(resource.key) !== entry) return this.open(resource, gzipAccepted, verify);
      await this.remove(entry); return undefined;
    }
  }

  /** Check retained output without materializing its body. open() authenticates
   * both encodings once per file stat, and again after replacement or damage. */
  async check(resource: Resource): Promise<boolean> {
    const saved = await this.open(resource);
    if (!saved) return false;
    await saved.handle.close();
    return true;
  }

  async checkAll(resources: Iterable<Resource>): Promise<boolean> {
    for (const resource of resources) if (!await this.check(resource)) return false;
    return true;
  }

  async get(resource: Resource, maxAgeMs = resource.ttl, signal?: AbortSignal): Promise<Payload & { hit: boolean }> {
    signal?.throwIfAborted();
    const cached = await this.read(resource, maxAgeMs);
    if (cached) return { ...cached, hit: true };
    const payload = await this.refresh(resource, signal);
    const saved = this.entries.get(resource.key);
    if (saved) this.touch(saved);
    this.assertFresh(resource, payload.checkedAt);
    return { ...payload, hit: false };
  }

  private async refresh(resource: Resource, signal?: AbortSignal): Promise<Payload> {
    signal?.throwIfAborted();
    this.signal.throwIfAborted();
    const existing = this.pending.get(resource.key);
    if (existing) return signal ? withAbort(existing, signal) : existing;
    const failure = this.failures.get(resource.key);
    // Clock rollback must not stretch a short quarantine into a long outage.
    // Preserve its full retry delay from the corrected clock if necessary.
    if (failure) failure.until = Math.min(failure.until, (this.options.now ?? Date.now)() + Math.max(5, failure.error.retryAfter) * 1000);
    if (failure && failure.until > (this.options.now ?? Date.now)()) return Promise.reject(failure.error);
    if (this.pending.size >= 32) return Promise.reject(new HttpError(503, 'Weather cache is busy', 5));
    const stats = this.productStats(cacheProduct(resource)); stats.loads++;
    // A cache fill belongs to the server. A viewer can stop waiting without
    // discarding shared acquisition/conversion that other viewers will reuse.
    const task = Promise.resolve().then(async () => {
      try {
        if (resource.indexHash) {
          const url = `${resource.url}.idx`;
          const index = await this.get({ key: url, upstream: resource.upstream, url, kind: 'index', ttl: 60_000, maxBytes: 512 * 1024, revalidate: true }, undefined, this.signal);
          if (index.sha256 !== resource.indexHash) throw new HttpError(409, 'Model index changed; discover this cycle again', 5);
        }
        this.signal.throwIfAborted();
        const payload = await this.options.load(resource, this.signal);
        this.signal.throwIfAborted();
        // Optional persistence can fail; response validation cannot.
        if (payload.body.length > resource.maxBytes || digest(payload.body) !== payload.sha256) throw new HttpError(502, 'Invalid weather source payload');
        // A long queue must not turn an already-expired response into a fresh cache entry.
        this.assertFresh(resource, payload.checkedAt);
        await this.put(resource, payload).catch(error => this.options.log?.(`Cache write failed: ${String(error)}`));
        this.assertFresh(resource, payload.checkedAt);
        this.failures.delete(resource.key);
        return payload;
      } catch (cause) {
        stats.loadFailures++;
        this.signal.throwIfAborted();
        const error = cause instanceof HttpError ? cause : new HttpError(502, 'Weather source unavailable', 5);
        if (this.failures.size >= 5000) this.failures.delete(this.failures.keys().next().value!);
        this.failures.set(resource.key, { error, until: (this.options.now ?? Date.now)() + Math.max(5, error.retryAfter) * 1000 });
        // Discovery probes unpublished cycles; NDFD images can be unpublished.
        // exhausted discovery or a failed pinned artifact logs its outer failure.
        if (!['index', 'coverage-image'].includes(resource.kind) || error.status !== 404) {
          this.options.log?.(`Update failed (${error.status}): ${resource.url}: ${String(cause)}`);
        }
        throw error;
      } finally { this.pending.delete(resource.key); }
    });
    this.pending.set(resource.key, task);
    return signal ? withAbort(task, signal) : task;
  }

  put(resource: Resource, payload: Payload, grace?: Grace): Promise<void> {
    const waited = this.publicationWait.start();
    const task = this.publication.catch(() => {}).then(() => { waited(); return this.save(resource, payload, grace); });
    this.publication = task;
    return task;
  }

  private async save(resource: Resource, payload: Payload, grace?: Grace): Promise<void> {
    if (payload.body.length > resource.maxBytes || digest(payload.body) !== payload.sha256) throw new Error('Invalid weather cache payload');
    if (payload.body.length > this.options.maxBytes) throw new HttpError(507, 'Weather file exceeds the cache budget');
    // JSON is compressed once during publication, never per viewer.
    const compressed = payload.body.length >= 1024 && payload.headers['content-type']?.startsWith('application/json')
      ? await compress(payload.body) : undefined;
    const encoded = compressed && compressed.length < payload.body.length ? compressed : undefined;
    const encoding = encoded ? { gzipBytes: encoded.length, gzipHash: digest(encoded) } : {};
    const previous = this.entries.get(resource.key);
    if (grace) await this.preserve(grace);
    await this.trim(payload.body.length + (encoded?.length ?? 0) - (previous ? storedBytes(previous) : 0), previous ? 0 : 1, resource.key);
    const metadata = Buffer.from(JSON.stringify({ resource, status: payload.status, headers: payload.headers,
      checkedAt: payload.checkedAt, sha256: payload.sha256, bytes: payload.body.length, ...encoding }));
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(metadata.length);
    const file = join(this.options.directory, `${randomUUID()}.cache`), temporary = file.replace(/\.cache$/, '.tmp');
    try {
      const handle = await open(temporary, 'wx');
      try {
        await handle.writeFile(prefix); await handle.writeFile(metadata); await handle.writeFile(payload.body);
        if (encoded) await handle.writeFile(encoded);
        await handle.sync();
      } finally { await handle.close(); }
      await rename(temporary, file);
    } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    const entry: Entry = { resource, product: cacheProduct(resource), status: payload.status, headers: payload.headers, checkedAt: payload.checkedAt,
      sha256: payload.sha256, bytes: payload.body.length, offset: metadata.length + 4, file,
      ...encoding, immutable: preparedRoute(resource)?.type === 'artifact', verified: true };
    this.entries.delete(resource.key); this.entries.set(resource.key, entry); this.account(entry, 1);
    this.failures.delete(resource.key);
    this.observed(entry, payload);
    if (previous) await this.remove(previous);
  }

  private async trim(additionalBytes = 0, additionalEntries = 0, replacing?: string, sweep = true): Promise<void> {
    if (this.deferPruning) return;
    const now = (this.options.now ?? Date.now)();
    for (const [key, until] of this.grace) {
      if (until <= now || !this.entries.has(key)) this.grace.delete(key);
      else if (until > now + MAX_GRACE_MS) this.grace.set(key, now + MAX_GRACE_MS);
    }
    const protectedKey = (key: string) => this.retained.has(key) || this.grace.has(key);
    // Reclaim unusable entries during publication even on hosts with ample disk.
    // Amortize the metadata scan; retained generations and the replacement stay protected.
    if (sweep && (this.lastExpirySweep === undefined || now < this.lastExpirySweep || now - this.lastExpirySweep >= 60_000)) {
      this.lastExpirySweep = now;
      for (const entry of [...this.entries.values()]) {
        if (entry.resource.key !== replacing && !protectedKey(entry.resource.key) && now - entry.checkedAt >= entry.resource.ttl) {
          await this.evict(entry, true);
        }
      }
    }
    const overBudget = () => this.bytes + additionalBytes > this.options.maxBytes ||
      this.entries.size + additionalEntries > (this.options.maxEntries ?? DEFAULT_WEATHER_CACHE_ENTRIES);
    if (!overBudget()) return;
    this.capacityTrims++;
    // Amortize pressure cleanup with small headroom in the exhausted dimension.
    // A snapshot avoids chasing readers that move entries during disk awaits.
    const maxEntries = this.options.maxEntries ?? DEFAULT_WEATHER_CACHE_ENTRIES;
    const byteTarget = this.options.maxBytes - (this.bytes + additionalBytes > this.options.maxBytes ? Math.min(64 * MiB, Math.floor(this.options.maxBytes / 20)) : 0);
    const entryTarget = maxEntries - (this.entries.size + additionalEntries > maxEntries ? Math.min(256, Math.floor(maxEntries / 20)) : 0);
    for (const entry of [...this.entries.values()]) {
      if (this.bytes + additionalBytes <= byteTarget && this.entries.size + additionalEntries <= entryTarget) return;
      if (entry.removed || entry.resource.key === replacing || protectedKey(entry.resource.key)) continue;
      await this.evict(entry, now - entry.checkedAt >= entry.resource.ttl);
    }
    if (overBudget()) {
      throw new HttpError(507, 'Weather cache cannot retain the published and replacement forecasts');
    }
  }

  private async evict(entry: Entry, expired: boolean): Promise<void> {
    if (entry.removed) return;
    if (expired) { this.expiredRemovals++; this.productStats(entry.product).expiredRemovals++; }
    else { this.capacityEvictions++; this.productStats(entry.product).capacityEvictions++; }
    await this.remove(entry);
  }

  private async remove(entry: Entry): Promise<void> {
    if (entry.removed) return;
    entry.removed = true;
    if (this.entries.get(entry.resource.key) === entry) this.entries.delete(entry.resource.key);
    this.account(entry, -1);
    // Each file is immutable, so a reader that already opened it can finish during eviction.
    await unlink(entry.file).catch(() => {});
  }
}
