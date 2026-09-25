import { mkdir, open, readdir, readFile, rename, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import { HttpError, resourceFor, type Resource } from './routes.ts';
import { digest, type Payload } from './upstream.ts';
import { withAbort } from '../../src/core/data/abort';

type Entry = Omit<Payload, 'body'> & { resource: Resource; bytes: number; offset: number; used: number; file: string; removed?: boolean;
  gzipBytes?: number; gzipHash?: string; verified?: boolean; verification?: Promise<void>; verificationStamp?: string };
const compress = promisify(gzip);
const storedBytes = (entry: Entry) => entry.bytes + (entry.gzipBytes ?? 0);
type Options = { directory: string; maxBytes: number; maxEntries?: number;
  load: (resource: Resource, signal: AbortSignal) => Promise<Payload>; signal?: AbortSignal;
  now?: (() => number) | undefined; log?: (message: string) => void };

/** One atomic file per artifact, including negotiated encodings. Only metadata
 * stays in memory; refreshes share one promise. */
export class WeatherCache {
  private entries = new Map<string, Entry>();
  private pending = new Map<string, Promise<Payload>>();
  private failures = new Map<string, { until: number; error: HttpError }>();
  private retained = new Set<string>();
  private publication: Promise<void> = Promise.resolve();
  private bytes = 0;
  private options: Options;
  private readonly signal: AbortSignal;
  constructor(options: Options) { this.options = options; this.signal = options.signal ?? new AbortController().signal; }

  async restore(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true });
    for (const name of await readdir(this.options.directory)) {
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
          const prepared = entry.resource.kind === 'prepared' && origin === 'http://weather.invalid' &&
            resourceFor(new URL(entry.resource.url).pathname).key === entry.resource.key;
          if (!(prepared || ['https://aviationweather.gov', 'https://nomads.ncep.noaa.gov', 'https://storage.googleapis.com', 'https://noaa-mrms-pds.s3.amazonaws.com', 'https://tgftp.nws.noaa.gov'].includes(origin) &&
            ['json', 'package', 'index', 'range', 'surface', 'coverage-image', 'radar-index', 'radar-data'].includes(entry.resource.kind)) ||
            typeof entry.resource.key !== 'string' || !entry.resource.key ||
            !Number.isSafeInteger(entry.resource.ttl) || entry.resource.ttl <= 0 || entry.resource.ttl > 86_400_000 ||
            ![200, 206].includes(entry.status) || !entry.headers || typeof entry.headers !== 'object' || Array.isArray(entry.headers) ||
            !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > 16 * 1024 * 1024 ||
            !Number.isSafeInteger(entry.checkedAt) || entry.checkedAt < 0 || entry.checkedAt > (this.options.now ?? Date.now)() ||
            (this.options.now ?? Date.now)() - entry.checkedAt >= entry.resource.ttl ||
            (entry.gzipBytes !== undefined && (!Number.isSafeInteger(entry.gzipBytes) || entry.gzipBytes <= 0 || entry.gzipBytes > entry.bytes ||
              !/^[a-f0-9]{64}$/.test(entry.gzipHash ?? ''))) ||
            stat.size !== size + 4 + storedBytes(entry) || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Expired or invalid cache');
          for (const [name, value] of Object.entries(entry.headers)) {
            if (typeof value !== 'string') throw new Error('Invalid cached response header');
            validateHeaderName(name); validateHeaderValue(name, value);
          }
          entry = { ...entry, file, offset: size + 4, used: 0, removed: false, verified: false };
          delete entry.verification;
          delete entry.verificationStamp;
        } finally { await handle.close(); }
        const previous = this.entries.get(entry.resource.key);
        if (previous && previous.checkedAt >= entry.checkedAt) { await unlink(file); continue; }
        if (previous) await this.remove(previous);
        this.entries.set(entry.resource.key, entry); this.bytes += storedBytes(entry);
      } catch { await unlink(file).catch(() => {}); }
    }
    await this.trim();
  }

  get stats() { return { entries: this.entries.size, bytes: this.bytes, updating: this.pending.size }; }
  storedSize(resource: Resource): number { const entry = this.entries.get(resource.key); return entry ? storedBytes(entry) : 0; }

  /** Published and building generations cannot be evicted by disposable source reads. */
  private readonly retentions = new Map<string, Set<string>>();
  retain(keys: Iterable<string>, owner = 'grids') {
    this.retentions.set(owner, new Set(keys));
    this.retained = new Set([...this.retentions.values()].flatMap(keys => [...keys]));
  }

  async discard(resource: Resource): Promise<void> {
    const entry = this.entries.get(resource.key);
    if (entry) await this.remove(entry);
  }

  /** After server shutdown, wait for outstanding reads/writes to release their files. */
  async drain(): Promise<void> { await Promise.allSettled([...this.pending.values(), this.publication]); }

  /** Freshness check; get() also authenticates the file contents. */
  has(resource: Resource, maxAgeMs = resource.ttl): boolean {
    const entry = this.entries.get(resource.key), now = (this.options.now ?? Date.now)();
    return !!entry && now >= entry.checkedAt && now - entry.checkedAt < Math.min(resource.ttl, maxAgeMs);
  }

  async read(resource: Resource, maxAgeMs = resource.ttl): Promise<Payload | undefined> {
    const entry = this.has(resource, maxAgeMs) ? this.entries.get(resource.key) : undefined;
    if (entry) {
      entry.used = (this.options.now ?? Date.now)();
      try {
        const body = (await readFile(entry.file)).subarray(entry.offset, entry.offset + entry.bytes);
        if (body.length !== entry.bytes || digest(body) !== entry.sha256) throw new Error('Damaged cache body');
        return { body, status: entry.status, headers: entry.headers, checkedAt: entry.checkedAt, sha256: entry.sha256 };
      } catch {
        if (this.entries.get(resource.key) !== entry) return this.read(resource, maxAgeMs);
        await this.remove(entry);
      }
    }
    return undefined;
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

  /** HTTP prepared reads stream saved bytes; they never enter the producer. */
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
      entry.used = (this.options.now ?? Date.now)();
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

  async get(resource: Resource, maxAgeMs = resource.ttl, signal?: AbortSignal): Promise<Payload & { hit: boolean }> {
    signal?.throwIfAborted();
    const cached = await this.read(resource, maxAgeMs);
    if (cached) return { ...cached, hit: true };
    const payload = await this.refresh(resource, signal);
    const saved = this.entries.get(resource.key);
    if (saved) saved.used = (this.options.now ?? Date.now)();
    return { ...payload, hit: false };
  }

  private async refresh(resource: Resource, signal?: AbortSignal): Promise<Payload> {
    signal?.throwIfAborted();
    this.signal.throwIfAborted();
    const existing = this.pending.get(resource.key);
    if (existing) return signal ? withAbort(existing, signal) : existing;
    const failure = this.failures.get(resource.key);
    if (failure && failure.until > (this.options.now ?? Date.now)()) return Promise.reject(failure.error);
    if (this.pending.size >= 32) return Promise.reject(new HttpError(503, 'Weather cache is busy', 5));
    // A cache fill belongs to the server. A viewer can stop waiting without
    // discarding shared acquisition/conversion that other viewers will reuse.
    const task = Promise.resolve().then(async () => {
      try {
        if (resource.indexHash) {
          const url = `${resource.url}.idx`;
          const index = await this.get({ key: url, upstream: resource.upstream, url, kind: 'index', ttl: 60_000, maxBytes: 512 * 1024 }, undefined, this.signal);
          if (index.sha256 !== resource.indexHash) throw new HttpError(409, 'Model index changed; discover this cycle again', 5);
        }
        this.signal.throwIfAborted();
        const payload = await this.options.load(resource, this.signal);
        this.signal.throwIfAborted();
        // Optional persistence can fail; response validation cannot.
        if (payload.body.length > resource.maxBytes || digest(payload.body) !== payload.sha256) throw new HttpError(502, 'Invalid weather source payload');
        // A long queue must not turn an already-expired response into a fresh cache entry.
        const age = (this.options.now ?? Date.now)() - payload.checkedAt;
        if (!Number.isSafeInteger(payload.checkedAt) || age < 0 || age >= resource.ttl) throw new HttpError(503, 'Weather source timestamp is not current', 5);
        await this.put(resource, payload).catch(error => this.options.log?.(`Cache write failed: ${String(error)}`));
        this.failures.delete(resource.key);
        return payload;
      } catch (cause) {
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

  put(resource: Resource, payload: Payload): Promise<void> {
    const task = this.publication.catch(() => {}).then(() => this.save(resource, payload));
    this.publication = task;
    return task;
  }

  private async save(resource: Resource, payload: Payload): Promise<void> {
    if (payload.body.length > resource.maxBytes || digest(payload.body) !== payload.sha256) throw new Error('Invalid weather cache payload');
    if (payload.body.length > this.options.maxBytes) throw new HttpError(507, 'Weather file exceeds the cache budget');
    // Prepared JSON is compressed once during publication, never per viewer.
    const compressed = resource.kind === 'prepared' && payload.body.length >= 1024 && payload.headers['content-type']?.startsWith('application/json')
      ? await compress(payload.body) : undefined;
    const encoded = compressed && compressed.length < payload.body.length ? compressed : undefined;
    const encoding = encoded ? { gzipBytes: encoded.length, gzipHash: digest(encoded) } : {};
    const previous = this.entries.get(resource.key);
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
    const entry: Entry = { resource, status: payload.status, headers: payload.headers, checkedAt: payload.checkedAt,
      sha256: payload.sha256, bytes: payload.body.length, offset: metadata.length + 4, used: previous?.used ?? (this.options.now ?? Date.now)(), file,
      ...encoding, verified: true };
    this.entries.set(resource.key, entry); this.bytes += storedBytes(entry);
    if (previous) await this.remove(previous);
  }

  private async trim(additionalBytes = 0, additionalEntries = 0, replacing?: string): Promise<void> {
    if (this.bytes + additionalBytes <= this.options.maxBytes && this.entries.size + additionalEntries <= (this.options.maxEntries ?? 5000)) return;
    const now = (this.options.now ?? Date.now)();
    const oldest = [...this.entries.values()].filter(entry => entry.resource.key !== replacing && !this.retained.has(entry.resource.key)).sort((a, b) =>
      Number(now - b.checkedAt >= b.resource.ttl) - Number(now - a.checkedAt >= a.resource.ttl) ||
      a.used - b.used || a.checkedAt - b.checkedAt);
    for (const entry of oldest) {
      if (this.bytes + additionalBytes <= this.options.maxBytes && this.entries.size + additionalEntries <= (this.options.maxEntries ?? 5000)) return;
      await this.remove(entry);
    }
    if (this.bytes + additionalBytes > this.options.maxBytes || this.entries.size + additionalEntries > (this.options.maxEntries ?? 5000)) {
      throw new HttpError(507, 'Weather cache cannot retain the published and replacement forecasts');
    }
  }

  private async remove(entry: Entry): Promise<void> {
    if (entry.removed) return;
    entry.removed = true;
    if (this.entries.get(entry.resource.key) === entry) this.entries.delete(entry.resource.key);
    this.bytes -= storedBytes(entry);
    // Each file is immutable, so a reader that already opened it can finish during eviction.
    await unlink(entry.file).catch(() => {});
  }
}
