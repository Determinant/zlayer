import { InvalidDataError, ResourceError } from '../data/errors';
import { discardResponseBody } from './response';
import { boundedBlobStream } from './blob-stream';
import { fileReceiptCacheName } from './cache-names';
import { readLockedFile, releaseUnusedFile } from './file-lifetime';
import { verificationReceipt } from './verification-receipt';
import { downloadFile, discardDownloadedFile } from './download-writer';
import { retireFile } from './download-cleanup';
import { DOWNLOAD_MEMORY_LIMIT, DOWNLOAD_WRITE_BYTES, DOWNLOAD_DIRECTORY, FILE_HEADER, downloads,
  storage, missing, fileNamePattern, requestUrl, withFileLock, memoryError } from './download-state';

type FileCache = Pick<Cache, 'match' | 'put' | 'delete' | 'keys'>;
type FileCaches = { name: string; legacy: Cache; receipts: Cache };
const fileCaches = new WeakMap<object, FileCaches>();
const fileResponses = new WeakMap<Response, { blob: Blob; claimed: boolean }>();

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
    put: (key, response) => withFileLock(key, 'exclusive', () => writeEntry(stores, key, response)),
    // A paused check may still have a pending browser read. Independent readers
    // can proceed together; replacement/removal must still wait for all readers.
    match: (...args) => withFileLock(args[0], 'shared', async () => {
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
    delete: (...args) => withFileLock(args[0], 'exclusive', async () => {
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
  return withFileLock(key, 'exclusive', async () => {
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
