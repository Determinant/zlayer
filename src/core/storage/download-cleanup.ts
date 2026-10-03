import { CHART_CACHE, PDF_CACHE, DATA_CACHE, fileReceiptCacheName } from './cache-names';
import { discardResponseBody } from './response';
import { deleteUnusedFile, withUnusedFiles } from './file-lifetime';
import { DOWNLOAD_DIRECTORY, FILE_HEADER, storage, missing, unavailable,
  fileNamePattern, keyHash, withFileLock } from './download-state';

const retired = new Map<string, { name: string; cache: Cache; url: string }>();
let retirementTimer: ReturnType<typeof setTimeout> | undefined;
let retiring = false;
export async function retireFile(cacheName: string, cache: Cache, url: string, name: string): Promise<void> {
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
  for (const logical of new Set([cacheName, CHART_CACHE, PDF_CACHE, DATA_CACHE])) {
    const receipt = await caches.match(url, { cacheName: fileReceiptCacheName(logical) });
    const referenced = receipt?.headers.get(FILE_HEADER) === name;
    discardResponseBody(receipt);
    if (referenced) return true; // A retained File was explicitly saved again.
  }
  // Pre-release legacy receipts may still refer to the file. Inspect keys only;
  // opening old complete bodies during cleanup would reintroduce large buffers.
  if ((await cache.keys(url, { ignoreVary: true })).length) return true;
  try {
    const directory = await (await storage()!.getDirectory()).getDirectoryHandle(DOWNLOAD_DIRECTORY);
    return await deleteUnusedFile(directory, name);
  } catch (error) { if (missing(error)) return true; throw error; }
}
function scheduleRetirement(): void {
  if (!retired.size || retirementTimer !== undefined || retiring) return;
  retirementTimer = setTimeout(() => {
    retirementTimer = undefined;
    retiring = true;
    void (async () => {
      // A live view can hold a File for hours. Retry infrequently and serially;
      // never rescan an entire cache or launch one task per retained reader.
      for (const [name, entry] of [...retired]) {
        if (retired.get(name) !== entry) continue; // Reset or another successful removal.
        await withFileLock(entry.url, 'exclusive', async () => {
          try { if (await removeRetiredFile(entry.name, entry.cache, entry.url, name)) retired.delete(name); }
          catch { /* Browser shutdown/full storage: the durable orphan sweep retries. */ }
        });
      }
    })().catch(() => {}).finally(() => { retiring = false; scheduleRetirement(); });
  }, 60_000);
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
const lastPruned = new WeakMap<StorageManager, number>();
/** Reclaim abandoned downloads after a day. Hold idle files against new readers
 * while inventorying receipts once. A publisher already owns a shared file lease,
 * so this also protects suspended writers and concurrent receipt publication. */
export async function pruneDownloadFiles(directory: FileSystemDirectoryHandle): Promise<void> {
  const manager = storage(), now = Date.now();
  const last = manager && lastPruned.get(manager);
  if (last !== undefined && now >= last && now - last < 86_400_000) return;
  // One sweep per storage context/day, not one full inventory scan per PDF book.
  pruning ??= (async () => {
    const stale = new Set<string>();
    for await (const name of directory.keys()) {
      if (fileNamePattern.test(name) && now - Number(name.split('-')[0]) > 86_400_000) stale.add(name);
    }
    if (!stale.size) return;
    await withUnusedFiles([...stale], async unused => {
      if (!unused.length) return;
      const candidates = new Set(unused);
      for (const name of [CHART_CACHE, PDF_CACHE, DATA_CACHE]) {
        const receipts = await caches.open(fileReceiptCacheName(name));
        for (const key of await receipts.keys()) {
          const response = await receipts.match(key);
          const file = response?.headers.get(FILE_HEADER);
          discardResponseBody(response);
          if (file) candidates.delete(file);
        }
      }
      if (!candidates.size) return;
      // Only abandoned candidates need the legacy scan. Keep its hash set bounded
      // by those candidates, not by the number of viewed chart packages.
      const hashes = new Set([...candidates].map(file => file.slice(-64)));
      const legacy = new Set<string>();
      for (const name of [CHART_CACHE, PDF_CACHE, DATA_CACHE]) {
        // Never open legacy complete bodies: WebKit can materialize them in memory.
        for (const key of await (await caches.open(name)).keys()) {
          const hash = await keyHash(key);
          if (hashes.has(hash)) legacy.add(hash);
        }
      }
      for (const file of candidates) if (!legacy.has(file.slice(-64))) {
        try { await directory.removeEntry(file); }
        catch (error) { if (!missing(error)) throw error; }
      }
    });
  })().then(() => { if (manager) lastPruned.set(manager, now); }).finally(() => { pruning = undefined; });
  await pruning;
}
