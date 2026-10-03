import { withAbort } from '../data/abort';
import { BASEMAP_CACHE, BASEMAP_METADATA_CACHE, DATA_CACHE } from './cache-names';
import { optionalStorage } from './optional-storage';
import { discardResponseBody } from './response';

const LOCK = `${BASEMAP_CACHE}:publication`;
const SAVED = 'x-zlayer-basemap-saved';
export const BASEMAP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const BASEMAP_MAX_ENTRIES = 512;
export const BASEMAP_MAX_BYTES = 64 * 1024 * 1024;
export const BASEMAP_MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_WRITES = 4;
let pendingWrites = 0;

export function isBasemapUrl(url: URL): boolean {
  return url.hostname === 'demotiles.maplibre.org' || url.hostname === 'tiles.openfreemap.org' ||
    url.hostname === 'basemap.nationalmap.gov' || url.hostname === 'services.arcgisonline.com' &&
    url.pathname.startsWith('/ArcGIS/rest/services/World_Imagery/MapServer/tile/');
}

function fresh(response: Response, now: number): boolean {
  const saved = Number(response.headers.get(SAVED));
  return saved > 0 && saved <= now && now - saved < BASEMAP_MAX_AGE_MS;
}

/** Disposable viewed tiles: no region ownership, completeness or offline promise.
 * Keep optional publication in the worker lifetime without delaying rendering. */
export async function basemapResponse(request: Request, keepAlive: (work: Promise<void>) => void): Promise<Response> {
  const cached = await optionalStorage(async () => globalThis.caches?.match(request, { cacheName: BASEMAP_CACHE }),
    request.signal, discardResponseBody).catch(() => { request.signal.throwIfAborted(); return undefined; });
  if (cached && fresh(cached, Date.now())) return cached;
  discardResponseBody(cached);
  const response = await fetch(request);
  // Opaque responses hide their size and may carry substantial quota padding.
  // Only readable, bounded bodies belong in this temporary cache.
  if (response.status === 200 && response.body && globalThis.navigator?.locks && pendingWrites < MAX_PENDING_WRITES) {
    const copy = response.clone();
    pendingWrites++;
    // Skip optional caching under pressure instead of queueing cloned bodies.
    // Hold admission through publication, including a stalled browser write.
    keepAlive(save(request, copy).catch(() => {}).finally(() => { pendingWrites--; }));
  }
  return response;
}

async function save(request: Request, response: Response): Promise<void> {
  try {
    const blob = await optionalStorage(signal => boundedBody(response, signal), request.signal);
    if (!blob) return;
    // Rendering already has its response. Keep the actual mutation alive for
    // reset accounting, even if a browser operation outlasts the deadline.
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
    await navigator.locks.request(LOCK, { signal }, async () => {
      signal.throwIfAborted();
      const cache = await caches.open(BASEMAP_CACHE), metadata = await caches.open(BASEMAP_METADATA_CACHE), now = Date.now();
      // Inventory bodyless receipts; reading all tile bodies here would make
      // every publication buffer the entire temporary cache in some browsers.
      const [keys, metadataKeys, receipts] = await Promise.all([cache.keys(), metadata.keys(), metadata.matchAll()]);
      const byUrl = new Map(metadataKeys.map((key, index) => [key.url, receipts[index]]));
      const remove = async (key: Request) => {
        signal.throwIfAborted(); await cache.delete(key);
        signal.throwIfAborted(); await metadata.delete(key);
      };
      const retained: { key: Request; bytes: number }[] = [];
      let total = blob.size;
      try {
        for (const key of keys) {
          signal.throwIfAborted();
          const entry = byUrl.get(key.url), bytes = Number(entry?.headers.get('content-length'));
          if (key.url === request.url || !entry || !fresh(entry, now) ||
            !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > BASEMAP_MAX_FILE_BYTES) await remove(key);
          else { retained.push({ key, bytes }); total += bytes; }
        }
        const present = new Set(keys.map(key => key.url));
        for (const key of metadataKeys) if (!present.has(key.url)) {
          signal.throwIfAborted(); await metadata.delete(key);
        }
      } finally { for (const entry of receipts) discardResponseBody(entry); }
      while (retained.length && (retained.length >= BASEMAP_MAX_ENTRIES || total > BASEMAP_MAX_BYTES)) {
        signal.throwIfAborted();
        const entry = retained.shift()!;
        await remove(entry.key); total -= entry.bytes;
      }
      const headers = new Headers(response.headers);
      headers.delete('content-encoding');
      headers.set('content-length', String(blob.size)); headers.set(SAVED, String(now));
      for (;;) {
        signal.throwIfAborted();
        try {
          await cache.put(request, new Response(blob, { headers }));
          signal.throwIfAborted();
          await metadata.put(request, new Response(null, { headers: {
            'content-length': String(blob.size), [SAVED]: String(now),
          } }));
          return;
        }
        catch (error) {
          if (!(error instanceof DOMException && error.name === 'QuotaExceededError') || !retained.length) throw error;
          await remove(retained.shift()!.key);
        }
      }
    });
  } finally { discardResponseBody(response); }
}

async function boundedBody(response: Response, signal: AbortSignal): Promise<Blob | undefined> {
  if (Number(response.headers.get('content-length')) > BASEMAP_MAX_FILE_BYTES) return undefined;
  const reader = response.body!.getReader(), parts: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) return size ? new Blob(parts) : undefined;
      size += value.byteLength;
      if (size > BASEMAP_MAX_FILE_BYTES) return undefined;
      parts.push(value);
    }
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Remove pre-bounded basemap entries without touching FAA reference documents. */
export async function removeLegacyBasemapFiles(signal?: AbortSignal): Promise<void> {
  if (!(await caches.keys()).includes(DATA_CACHE)) return;
  signal?.throwIfAborted();
  const cache = await caches.open(DATA_CACHE);
  for (const key of await cache.keys()) if (isBasemapUrl(new URL(key.url))) {
    signal?.throwIfAborted(); await cache.delete(key);
  }
}

export async function removeTemporaryBasemapFiles(): Promise<void> {
  await navigator.locks.request(LOCK, { mode: 'exclusive' }, async () => {
    await caches.delete(BASEMAP_CACHE);
    await caches.delete(BASEMAP_METADATA_CACHE);
    await removeLegacyBasemapFiles();
  });
}
