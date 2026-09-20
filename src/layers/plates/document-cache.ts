import type { ProcedureDocument } from './data';
import { PDF_CACHE, VERIFIED_SHA256_HEADER } from '../../core/storage/cache-names';
import { noteCacheAccess } from '../../core/storage/cache-access';
import { readArtifact, verifyBlob } from '../../core/storage/artifacts';
import { httpResourceError, InvalidDataError } from '../../core/data/errors';
import { discardResponseBody } from '../../core/storage/response';
import { verificationReceipt } from '../../core/storage/verification-receipt';

const CACHE_NAME = PDF_CACHE;
export type ProcedureDownloadProgress = {
  phase: 'downloading' | 'preparing';
  loaded: number;
  total: number | undefined;
};
type ProgressListener = (progress: ProcedureDownloadProgress) => void;
type ProgressUpdates = { latest?: ProcedureDownloadProgress; listeners: Set<ProgressListener> };
const requests = new Map<string, {
  result: Promise<{ blob: Blob; cached: boolean }>;
  updates: ProgressUpdates;
}>();

/** Offline download does not allocate an extra viewer ArrayBuffer for the book. */
export async function cacheProcedureDocument(source: ProcedureDocument): Promise<void> {
  if (!(await loadProcedureDocument(source)).cached) throw new Error('Plate could not be saved; storage may be full');
}

/** Readers share an immutable Blob; PDF.js receives only the ranges it needs. */
export async function loadProcedureDocument(source: ProcedureDocument,
  onProgress?: ProgressListener): Promise<{ blob: Blob; cached: boolean }> {
  await noteCacheAccess(PDF_CACHE, source.url);
  const key = JSON.stringify([source.url, source.sha256, source.byteLength]);
  let request = requests.get(key);
  if (!request) {
    const updates: ProgressUpdates = { listeners: new Set() };
    const result = load(source, progress => {
      updates.latest = progress;
      for (const listener of updates.listeners) listener(progress);
    });
    request = { result, updates };
    requests.set(key, request);
    void result.finally(() => requests.delete(key)).catch(() => {});
  }
  if (onProgress) {
    request.updates.listeners.add(onProgress);
    if (request.updates.latest) onProgress(request.updates.latest);
  }
  try {
    return await request.result;
  } finally {
    if (onProgress) request.updates.listeners.delete(onProgress);
  }
}

async function load(source: ProcedureDocument, onProgress: ProgressListener): Promise<{ blob: Blob; cached: boolean }> {
  let cache: Cache | undefined;
  try {
    cache = await caches.open(CACHE_NAME);
    const stored = await readArtifact(cache, source.url, async stored => {
      const receipt = stored.headers.get(VERIFIED_SHA256_HEADER);
      return { ...await checkedPdf(stored, source, receipt),
        receipt, byteLength: Number(stored.headers.get('content-length')) };
    });
    if (stored.state === 'ready') {
      const { blob, sha256, receipt, byteLength } = stored.value;
      if (receipt !== sha256 || byteLength !== blob.size) {
        await cache.put(source.url, new Response(blob, { headers: pdfHeaders(blob, sha256) })).catch(() => {});
      }
      return { blob, cached: true };
    }
    if (stored.state === 'invalid') await cache.delete(source.url).catch(() => {});
    // Preserve offline books saved before content-addressed URLs were introduced.
    // A legacy URL is usable only when its bytes match the current book identity.
    if (source.sha256 && source.byteLength) {
      const legacyUrl = new URL(source.url);
      legacyUrl.searchParams.delete('sha256');
      legacyUrl.searchParams.delete('bytes');
      const legacy = legacyUrl.href === source.url ? undefined : await cache.match(legacyUrl.href);
      if (legacy) {
        try {
          const { blob, sha256 } = await checkedPdf(legacy, source, legacy.headers.get(VERIFIED_SHA256_HEADER));
          try {
            await cache.put(source.url, new Response(blob, { headers: pdfHeaders(blob, sha256) }));
            await cache.delete(legacyUrl.href);
          } catch { /* Preserve the usable legacy entry if migration cannot commit. */ }
          return { blob, cached: true };
        }
        catch { /* It may be a valid older edition; do not relabel or delete it. */ }
      }
    }
  } catch { /* Denied storage must not prevent online viewing. */ }

  onProgress({ phase: 'downloading', loaded: 0, total: source.byteLength });
  const response = await fetch(procedureFetchUrl(source.url), {
    cache: 'no-store', signal: AbortSignal.timeout(600_000),
  });
  if (response.status !== 200) {
    discardResponseBody(response);
    throw httpResourceError(response.status, source.source === 'faa-individual'
      ? `FAA fallback unavailable (${response.status}). The /faa-procedures proxy or a hosted TPP book is required.`
      : `Unable to load procedure book: ${response.status}`);
  }
  const { blob, sha256 } = await checkedPdf(response, source, undefined, onProgress)
    .finally(() => discardResponseBody(response));
  try {
    if (cache) {
      await cache.put(source.url, new Response(blob, { headers: pdfHeaders(blob, sha256) }));
      return { blob, cached: true };
    }
  } catch { /* A verified document can still be viewed when storage is full. */ }
  return { blob, cached: false };
}

function pdfHeaders(blob: Blob, sha256: string): HeadersInit {
  return { 'content-type': 'application/pdf', 'content-length': String(blob.size),
    [VERIFIED_SHA256_HEADER]: sha256,
  };
}

async function checkedPdf(response: Response, source: ProcedureDocument,
  receipt?: string | null, onProgress?: ProgressListener): Promise<{ blob: Blob; sha256: string }> {
  if (response.status !== 200 || !response.headers.get('content-type')?.toLowerCase().includes('application/pdf')) {
    throw new InvalidDataError('Procedure response is not a complete PDF');
  }
  const blob = onProgress ? await downloadBlob(response, source, onProgress) : await response.blob();
  if (!(await blob.slice(0, 1024).text()).includes('%PDF-')) throw new InvalidDataError('Procedure response is not a PDF');
  if (source.byteLength !== undefined && blob.size !== source.byteLength) {
    throw new InvalidDataError(`Procedure PDF size mismatch: expected ${source.byteLength}, received ${blob.size}`);
  }
  // Cache Storage commits these bytes and their receipt together after verification.
  // Reuse that result across viewer openings and app restarts instead of scanning
  // an entire book again. Downloads and entries without receipts still take the full hash path.
  const expectedSha256 = source.sha256 ?? (receipt || undefined);
  const verified = receipt ? verificationReceipt(response.headers, { byteLength: blob.size,
    ...(expectedSha256 ? { sha256: expectedSha256 } : {}) }) : undefined;
  if (verified) {
    return { blob, sha256: verified.sha256 };
  }
  const sha256 = await verifyBlob(blob, expectedSha256 ? { ...source, sha256: expectedSha256 } : source, 'Procedure PDF');
  return { blob, sha256 };
}

async function downloadBlob(response: Response, source: ProcedureDocument, onProgress: ProgressListener): Promise<Blob> {
  // Catalog sizes describe decoded PDF bytes. An encoded Content-Length does not.
  const encoding = response.headers.get('content-encoding');
  const length = source.byteLength ?? ((!encoding || encoding === 'identity')
    ? Number(response.headers.get('content-length')) : 0);
  const total = Number.isFinite(length) && length > 0 ? length : undefined;
  let loaded = 0, lastPercent = 0, lastUpdate = performance.now();
  onProgress({ phase: 'downloading', loaded, total });
  // Let the browser accumulate the Blob, without retaining a second set of chunks.
  const body = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      loaded += chunk.byteLength;
      const percent = total ? Math.min(100, Math.floor(loaded / total * 100)) : undefined;
      const now = performance.now();
      if (percent !== undefined ? percent > lastPercent : now - lastUpdate >= 100) {
        onProgress({ phase: 'downloading', loaded, total });
        lastPercent = percent ?? 0;
        lastUpdate = now;
      }
      controller.enqueue(chunk);
    },
  }));
  const blob = await (body ? new Response(body, { headers: response.headers }) : response).blob();
  onProgress({ phase: 'preparing', loaded: blob.size, total: blob.size });
  return blob;
}

export function procedureFetchUrl(url: string, proxyRoot = import.meta.env?.VITE_ZLAYERS_PROCEDURE_PROXY_ROOT?.trim() || '/faa-procedures'): string {
  const parsed = new URL(url);
  // Only this fixed FAA path is proxied; never create a general URL relay.
  const path = parsed.origin === 'https://aeronav.faa.gov'
    ? parsed.pathname.match(/^\/d-tpp\/(\d{4}\/[-\w]+\.pdf)$/i)?.[1] : undefined;
  return path ? `${proxyRoot.replace(/\/+$/, '')}/${path}${parsed.search}` : url;
}
