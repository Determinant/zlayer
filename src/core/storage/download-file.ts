import { InvalidDataError, ResourceError } from '../data/errors';
import { discardResponseBody } from './response';
import { boundedBlobStream } from './blob-stream';
import { CHART_CACHE, PDF_CACHE, fileReceiptCacheName } from './cache-names';
import { deleteUnusedFile, readLockedFile, releaseUnusedFile } from './file-lifetime';
import { verificationReceipt } from './verification-receipt';

export const DOWNLOAD_MEMORY_LIMIT = 8 * 1024 * 1024;
export const DOWNLOAD_WRITE_BYTES = 64 * 1024;
export const DOWNLOAD_DIRECTORY = 'zlayer-downloads';
const FILE_HEADER = 'x-zlayer-local-file';
type FileCache = Pick<Cache, 'match' | 'put' | 'delete' | 'keys'>;
type DiskFile = { directory: FileSystemDirectoryHandle; name: string; committed: boolean; key?: string };
type FileCaches = { name: string; legacy: Cache; receipts: Cache };
const fileCaches = new WeakMap<object, FileCaches>();
const downloads = new WeakMap<Blob, DiskFile>();
const fileResponses = new WeakMap<Response, { blob: Blob; claimed: boolean }>();
const storage = () => globalThis.navigator?.storage;
const missing = (error: unknown) => error instanceof DOMException && error.name === 'NotFoundError';
const unavailable = (error: unknown) => error instanceof DOMException &&
  ['NotSupportedError', 'SecurityError', 'UnknownError'].includes(error.name);
const fileNamePattern = /^\d+-[a-f0-9-]{36}-[a-f0-9]{64}$/;
const requestUrl = (key: RequestInfo | URL) => key instanceof Request ? key.url : String(key);
async function keyHash(key: RequestInfo | URL): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(requestUrl(key)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function exclusive<T>(key: RequestInfo | URL, work: () => Promise<T>): Promise<T> {
  // Small in-memory fallback entries also work in browsers without Web Locks.
  if (!globalThis.navigator?.locks) return work();
  return navigator.locks.request(`zlayer-download-key:${await keyHash(key)}`, { mode: 'exclusive' }, work);
}
const memoryError = () => new ResourceError('storage',
  'This download needs local file storage to stay within the memory limit. Free device storage, enable site storage, or update your browser, then retry.');

/** Cache Storage may buffer an entire body in WebKit, even when given a stream
 * or disk-backed Blob. Large verified files live in OPFS; Cache Storage holds
 * their small receipts. Keep the same public URLs and one durable file per entry. */
export async function openFileCache(name: string): Promise<FileCache> {
  const cache = await caches.open(name);
  const receipts = await caches.open(fileReceiptCacheName(name));
  const stores = { name, legacy: cache, receipts };
  const result: FileCache = {
    keys: async (...args) => {
      const keys = [...await cache.keys(...args), ...await receipts.keys(...args)];
      return [...new Map(keys.map(key => [key.url, key])).values()];
    },
    put: (key, response) => exclusive(key, () => writeEntry(stores, key, response)),
    match: (...args) => exclusive(args[0], async () => {
      const receipt = await receipts.match(...args);
      let invalid: unknown;
      try {
        if (receipt) return await fileResponse(receipt, args[0]);
      } catch (error) { if (!missing(error)) invalid = error; }
      // An evicted/invalid new file must not hide a usable older complete copy.
      const legacy = await cache.match(...args);
      if (legacy) {
        if (!legacy.headers.has(FILE_HEADER)) return legacy;
        try { return await fileResponse(legacy, args[0]); }
        catch (error) { if (!missing(error)) throw error; }
      }
      if (invalid) throw invalid;
      return undefined;
    }),
    delete: (...args) => exclusive(args[0], async () => {
      const receipt = await receipts.match(...args);
      const file = receipt?.headers.get(FILE_HEADER);
      discardResponseBody(receipt);
      // Failed cache deletion keeps its file intact, so removal can be retried.
      // Never match old complete bodies merely to delete them: WebKit may buffer
      // the entire book. Any early pre-release file receipt becomes an orphan.
      const oldRemoved = await cache.delete(...args);
      const removed = await receipts.delete(...args);
      if (file && fileNamePattern.test(file)) {
        await retireFile(name, cache, requestUrl(args[0]), file);
      }
      return removed || oldRemoved;
    }),
  };
  fileCaches.set(result, stores);
  return result;
}

/** The URL lock covers both the metadata switch and retirement of its old file. */
async function writeEntry({ name, legacy, receipts }: FileCaches, key: RequestInfo | URL, response: Response): Promise<void> {
  const prior = await receipts.match(key).catch(() => undefined);
  const oldFile = prior?.headers.get(FILE_HEADER);
  discardResponseBody(prior);
  if (response.headers.has(FILE_HEADER)) await receipts.put(key, response);
  else {
    await legacy.put(key, response);
    if (oldFile) await receipts.delete(key);
  }
  if (oldFile && oldFile !== response.headers.get(FILE_HEADER) && fileNamePattern.test(oldFile)) {
    await retireFile(name, legacy, requestUrl(key), oldFile);
  }
}

async function fileResponse(response: Response, key: RequestInfo | URL): Promise<Response> {
  discardResponseBody(response);
  const name = response.headers.get(FILE_HEADER) ?? '';
  if (!fileNamePattern.test(name)) throw new InvalidDataError('Invalid local file receipt');
  const root = await storage()?.getDirectory?.();
  if (!root) throw memoryError();
  const directory = await root.getDirectoryHandle(DOWNLOAD_DIRECTORY);
  const blob = await readLockedFile(directory, name);
  if (blob.size !== Number(response.headers.get('content-length'))) {
    releaseUnusedFile(blob);
    throw new InvalidDataError('Stored file size mismatch');
  }
  downloads.set(blob, { directory, name, committed: true, key: requestUrl(key) });
  const state = { blob, claimed: false };
  let offset = 0;
  const release = () => { if (!state.claimed) releaseUnusedFile(blob); };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (offset === blob.size) { controller.close(); release(); return; }
        const end = Math.min(blob.size, offset + DOWNLOAD_WRITE_BYTES);
        const bytes = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
        offset = end; controller.enqueue(bytes);
      } catch (error) { controller.error(error); release(); }
    },
    cancel: release,
  }, { highWaterMark: 0 });
  const headers = new Headers(response.headers);
  headers.delete(FILE_HEADER);
  const result = new Response(body, { status: response.status, headers });
  fileResponses.set(result, state);
  return result;
}

/** Preserve the OPFS File itself instead of asking Fetch to reassemble its body. */
export async function storedFileBlob(response: Response): Promise<Blob> {
  const state = fileResponses.get(response);
  if (!state) return response.blob();
  state.claimed = true;
  return state.blob;
}

/** Consume one network chunk at a time, awaiting disk writes before reading more.
 * The fallback has a hard byte ceiling, including unknown/misreported lengths. */
export async function downloadFile(response: Response, options: {
  key: RequestInfo | URL; byteLength?: number | undefined; label: string; onProgress?: (loaded: number) => void;
}): Promise<Blob> {
  let disk: DiskFile | undefined, writer: FileSystemWritableFileStream | undefined, writing: Blob | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined;
  let parts: Uint8Array<ArrayBuffer>[] = [];
  let loaded = 0;
  try {
    if (options.byteLength === undefined || options.byteLength > DOWNLOAD_MEMORY_LIMIT) {
      try {
        const root = await storage()?.getDirectory?.();
        if (root && navigator.locks) {
          const directory = await root.getDirectoryHandle(DOWNLOAD_DIRECTORY, { create: true });
          await pruneDownloadFiles(directory);
          const name = `${Date.now()}-${crypto.randomUUID()}-${await keyHash(options.key)}`;
          disk = { directory, name, committed: false, key: requestUrl(options.key) };
          const file = await directory.getFileHandle(name, { create: true });
          writing = await readLockedFile(directory, name);
          if (typeof file.createWritable === 'function') writer = await file.createWritable();
        }
      } catch { /* The bounded fallback below also covers denied/full local storage. */ }
      if (!writer && disk) { await disk.directory.removeEntry(disk.name).catch(() => {}); disk = undefined; }
    }
    if (!writer && (options.byteLength ?? 0) > DOWNLOAD_MEMORY_LIMIT) throw memoryError();
    reader = response.body?.getReader();
    if (reader) for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const next = loaded + value.byteLength;
      if (options.byteLength !== undefined && next > options.byteLength) {
        throw new InvalidDataError(`${options.label} size mismatch: expected ${options.byteLength}, received at least ${next}`);
      }
      if (!writer && next > DOWNLOAD_MEMORY_LIMIT) throw memoryError();
      for (let offset = 0; offset < value.byteLength; offset += DOWNLOAD_WRITE_BYTES) {
        // WebKit can write the entire backing buffer of a typed-array view.
        // Give it an exact bounded allocation, including nonzero-offset slices.
        const part = value.slice(offset, offset + DOWNLOAD_WRITE_BYTES);
        if (writer) await writer.write(part);
        else parts.push(part);
      }
      loaded = next;
      options.onProgress?.(loaded);
    }
    if (options.byteLength !== undefined && loaded !== options.byteLength) {
      throw new InvalidDataError(`${options.label} size mismatch: expected ${options.byteLength}, received ${loaded}`);
    }
    if (writer && disk) {
      await writer.close(); writer = undefined;
      const blob = await readLockedFile(disk.directory, disk.name);
      if (blob.size !== loaded) {
        releaseUnusedFile(blob);
        throw new InvalidDataError(`${options.label} stored size mismatch: expected ${loaded}, received ${blob.size}`);
      }
      downloads.set(blob, disk);
      return blob;
    }
    return new Blob(parts, { type: response.headers.get('content-type') ?? '' });
  } catch (error) {
    if (reader) await reader.cancel(error).catch(() => {});
    else discardResponseBody(response);
    await writer?.abort().catch(() => {});
    if (disk) await disk.directory.removeEntry(disk.name).catch(() => {});
    throw error;
  } finally {
    if (writing) releaseUnusedFile(writing);
    parts = [];
    reader?.releaseLock();
  }
}

/** Publish verified bytes, or reuse a matching file another context committed
 * while this download was in flight. Callers use the returned Blob and discard
 * their original uncommitted download; a losing transfer must not replace readers. */
export async function storeDownloadedFile(cache: Pick<Cache, 'put'>, key: RequestInfo | URL,
  blob: Blob, headers: HeadersInit): Promise<Blob> {
  const disk = downloads.get(blob);
  // A legacy cache migration or a new URL needs its own file; deleting the old
  // entry must not invalidate another receipt. Never send a large Blob to put().
  if ((!disk && blob.size > DOWNLOAD_MEMORY_LIMIT) || (disk?.key && disk.key !== requestUrl(key))) {
    const copy = await downloadFile(new Response(boundedBlobStream(blob)), { key, byteLength: blob.size, label: 'Stored file' });
    try { return await storeDownloadedFile(cache, key, copy, headers); }
    finally { await discardDownloadedFile(copy); }
  }
  if (disk) {
    try {
      const file = await (await disk.directory.getFileHandle(disk.name)).getFile();
      if (file.size !== blob.size) throw new Error('Stored file size mismatch');
    } catch (cause) { throw new DOMException(`Downloaded file is no longer readable: ${String(cause)}`, 'NotReadableError'); }
  }
  const storedHeaders = new Headers(headers);
  storedHeaders.delete(FILE_HEADER);
  if (!disk) {
    await cache.put(key, new Response(blob, { status: 200, headers: storedHeaders }));
    return blob;
  }
  const stores = fileCaches.get(cache);
  if (!stores) throw new ResourceError('storage', 'A file-backed download requires a file-aware cache');
  return exclusive(key, async () => {
    const expected = verificationReceipt(storedHeaders, { byteLength: blob.size });
    const prior = await stores.receipts.match(key).catch(() => undefined);
    try {
      if (expected && prior?.status === 200 &&
        prior.headers.get('content-type') === storedHeaders.get('content-type') && verificationReceipt(prior.headers, expected)) {
        try {
          const existing = await fileResponse(prior, key);
          try { return await storedFileBlob(existing); }
          finally { discardResponseBody(existing); }
        } catch { /* Missing/damaged file: publish this verified replacement. */ }
      }
    } finally { discardResponseBody(prior); }
    storedHeaders.set(FILE_HEADER, disk.name);
    await writeEntry(stores, key, new Response(null, { status: 200, headers: storedHeaders }));
    disk.committed = true; disk.key = requestUrl(key);
    return blob;
  });
}

/** Failed verification/publication must not leave a partial or untrusted file. */
export async function discardDownloadedFile(blob: Blob): Promise<void> {
  const disk = downloads.get(blob);
  if (disk && !disk.committed) {
    releaseUnusedFile(blob);
    await disk.directory.removeEntry(disk.name).catch(() => {});
  }
}

const retired = new Map<string, { name: string; cache: Cache; url: string }>();
let retirementTimer: ReturnType<typeof setTimeout> | undefined;
async function retireFile(cacheName: string, cache: Cache, url: string, name: string): Promise<void> {
  retired.set(name, { name: cacheName, cache, url });
  // The caller holds the URL lock. A busy reader delays physical reclamation,
  // never logical cache removal, and can keep reading the immutable old file.
  try { if (await removeRetiredFile(cacheName, cache, url, name)) retired.delete(name); }
  catch { /* Retain the cleanup job; a later attempt or orphan sweep can retry. */ }
  scheduleRetirement();
}
async function removeRetiredFile(cacheName: string, cache: Cache, url: string, name: string): Promise<boolean> {
  // Read existing caches without open(): background cleanup must never recreate
  // a namespace after reset, nor delete a file published in another file cache.
  for (const logical of new Set([cacheName, CHART_CACHE, PDF_CACHE])) {
    const receipt = await caches.match(url, { cacheName: fileReceiptCacheName(logical) });
    const referenced = receipt?.headers.get(FILE_HEADER) === name;
    discardResponseBody(receipt);
    if (referenced) return true; // A retained File was explicitly saved again.
  }
  // Pre-release legacy receipts may still refer to the file. Inspect keys only;
  // opening old complete bodies during cleanup would reintroduce large buffers.
  if ((await cache.keys()).some(key => key.url === url)) return true;
  try {
    const directory = await (await storage()!.getDirectory()).getDirectoryHandle(DOWNLOAD_DIRECTORY);
    return await deleteUnusedFile(directory, name);
  } catch (error) { if (missing(error)) return true; throw error; }
}
function scheduleRetirement(): void {
  if (!retired.size || retirementTimer !== undefined) return;
  retirementTimer = setTimeout(() => {
    retirementTimer = undefined;
    void Promise.all([...retired].map(async ([name, { name: cacheName, cache, url }]) => {
      await exclusive(url, async () => {
        try { if (await removeRetiredFile(cacheName, cache, url, name)) retired.delete(name); }
        catch { /* Browser shutdown/full storage: the durable orphan sweep retries. */ }
      });
    })).catch(() => {}).finally(scheduleRetirement);
  }, 1_000);
  // Node's storage tests use the same Web Locks implementation; cleanup timers
  // must not keep a terminated test context alive.
  if (typeof retirementTimer === 'object' && 'unref' in retirementTimer) retirementTimer.unref();
}

/** Full reset runs after the workspace and its writers have stopped. */
export async function removeDownloadFiles(): Promise<void> {
  if (!storage()?.getDirectory) return;
  let root: FileSystemDirectoryHandle;
  try { root = await storage()!.getDirectory(); }
  catch (error) { if (unavailable(error)) return; throw error; }
  try { await root.removeEntry(DOWNLOAD_DIRECTORY, { recursive: true }); }
  catch (error) { if (!missing(error)) throw error; }
  retired.clear();
  clearTimeout(retirementTimer); retirementTimer = undefined;
}

let pruning: Promise<void> | undefined;
/** Reclaim abandoned downloads after a day. Never open a legacy body. Receipt
 * inspection and reclamation share publication's URL lock, and file locks protect
 * live readers and suspended writers even if their files are more than a day old. */
async function pruneDownloadFiles(directory: FileSystemDirectoryHandle): Promise<void> {
  pruning ??= (async () => {
    const stale = new Set<string>();
    for await (const name of directory.keys()) {
      if (fileNamePattern.test(name) && Date.now() - Number(name.split('-')[0]) > 86_400_000) stale.add(name);
    }
    if (!stale.size) return;
    for (const file of stale) {
      const hash = file.slice(-64);
      await navigator.locks.request(`zlayer-download-key:${hash}`, { mode: 'exclusive' }, async () => {
        for (const name of [CHART_CACHE, PDF_CACHE]) {
          const cache = await caches.open(name);
          for (const key of await cache.keys()) if (await keyHash(key) === hash) return;
          const receipts = await caches.open(fileReceiptCacheName(name));
          for (const key of await receipts.keys()) if (await keyHash(key) === hash) {
            const response = await receipts.match(key);
            const referenced = response?.headers.get(FILE_HEADER) === file;
            discardResponseBody(response);
            if (referenced) return;
          }
        }
        await deleteUnusedFile(directory, file).catch(() => {});
      });
    }
  })().finally(() => { pruning = undefined; });
  await pruning;
}
