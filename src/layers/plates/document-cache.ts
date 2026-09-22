import type { ProcedureDocument } from './data';
import { PDF_CACHE, VERIFIED_SHA256_HEADER } from '../../core/storage/cache-names';
import { noteCacheAccess } from '../../core/storage/cache-access';
import { readArtifact, verifyBlob } from '../../core/storage/artifacts';
import { InvalidDataError, ResourceError } from '../../core/data/errors';
import { discardResponseBody } from '../../core/storage/response';
import { verificationReceipt } from '../../core/storage/verification-receipt';
import { openFileCache, storedFileBlob, storeDownloadedFile, discardDownloadedFile, DOWNLOAD_MEMORY_LIMIT } from '../../core/storage/download-file';

import { transferFile } from '../../core/storage/file-transfer';

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
  let cache: Awaited<ReturnType<typeof openFileCache>> | undefined;
  try {
    cache = await openFileCache(CACHE_NAME);
    const stored = await readArtifact(cache, source.url, async stored => {
      const receipt = stored.headers.get(VERIFIED_SHA256_HEADER);
      return { ...await checkedPdf(stored, source, receipt),
        receipt, byteLength: Number(stored.headers.get('content-length')) };
    });
    if (stored.state === 'ready') {
      const { blob, sha256, receipt, byteLength } = stored.value;
      if (receipt !== sha256 || byteLength !== blob.size) {
        await storeDownloadedFile(cache, source.url, blob, pdfHeaders(blob, sha256)).catch(() => {});
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
            await storeDownloadedFile(cache, source.url, blob, pdfHeaders(blob, sha256));
            const migrated = await cache.match(source.url);
            if (!migrated) throw new Error('Migrated book was not saved');
            let migratedBlob: Blob;
            try { migratedBlob = await storedFileBlob(migrated); }
            finally { discardResponseBody(migrated); }
            await cache.delete(legacyUrl.href);
            return { blob: migratedBlob, cached: true };
          } catch { /* Preserve the usable legacy entry if migration cannot commit. */ }
          return { blob, cached: true };
        }
        catch { /* It may be a valid older edition; do not relabel or delete it. */ }
        finally { discardResponseBody(legacy); }
      }
    }
  } catch { /* Denied storage must not prevent online viewing. */ }

  onProgress({ phase: 'downloading', loaded: 0, total: source.byteLength });
  return download(source, onProgress, cache);
}

async function download(source: ProcedureDocument, onProgress: ProgressListener,
  cache: Awaited<ReturnType<typeof openFileCache>> | undefined): Promise<{ blob: Blob; cached: boolean }> {
  let lastPercent = 0, lastUpdate = performance.now();
  return transferFile({ url: procedureFetchUrl(source.url), key: source.url, label: 'Procedure PDF',
    byteLength: source.byteLength, timeoutMs: 600_000, exclusive: true,
    validateResponse: requirePdfResponse,
    statusMessage: status => source.source === 'faa-individual'
      ? `FAA fallback unavailable (${status}). The /faa-procedures proxy or a hosted TPP book is required.`
      : `Unable to load procedure book: ${status}`,
    onProgress(loaded, total) {
      const percent = total ? Math.min(100, Math.floor(loaded / total * 100)) : undefined;
      const now = performance.now();
      if (!loaded || (percent !== undefined ? percent > lastPercent : now - lastUpdate >= 100)) {
        onProgress({ phase: 'downloading', loaded, total });
        lastPercent = percent ?? 0; lastUpdate = now;
      }
    },
  }, async ({ blob: downloaded, response }) => {
    onProgress({ phase: 'preparing', loaded: downloaded.size, total: downloaded.size });
    const { blob, sha256 } = await checkedPdf(response, source, undefined, downloaded);
    try {
      if (cache) {
        const saved = await storeDownloadedFile(cache, source.url, blob, pdfHeaders(blob, sha256));
        return { blob: saved, cached: true };
      }
    } catch (error) {
      if (blob.size > DOWNLOAD_MEMORY_LIMIT) throw error;
      // Small verified documents can still be viewed when storage is full.
    }
    if (blob.size > DOWNLOAD_MEMORY_LIMIT) {
      throw new ResourceError('storage', 'This document needs local storage. Enable site storage and retry.');
    }
    // Unknown-size small PDFs may also have used disk. Preserve a bounded copy
    // for online viewing before removing their uncommitted file.
    return { blob: new Blob([await blob.arrayBuffer()], { type: 'application/pdf' }), cached: false };
  });
}

function pdfHeaders(blob: Blob, sha256: string): HeadersInit {
  return { 'content-type': 'application/pdf', 'content-length': String(blob.size),
    [VERIFIED_SHA256_HEADER]: sha256,
  };
}

async function checkedPdf(response: Response, source: ProcedureDocument,
  receipt?: string | null, downloaded?: Blob): Promise<{ blob: Blob; sha256: string }> {
  requirePdfResponse(response);
  const blob = downloaded ?? await storedFileBlob(response);
  try {
    if (!(await blob.slice(0, 1024).text()).includes('%PDF-')) throw new InvalidDataError('Procedure response is not a PDF');
    if (source.byteLength !== undefined && blob.size !== source.byteLength) {
      throw new InvalidDataError(`Procedure PDF size mismatch: expected ${source.byteLength}, received ${blob.size}`);
    }
    // Receipts publish only complete, verified bytes. Reuse them across viewer
    // openings and restarts; new downloads always take the full hash path.
    const expectedSha256 = source.sha256 ?? (receipt || undefined);
    const verified = receipt ? verificationReceipt(response.headers, { byteLength: blob.size,
      ...(expectedSha256 ? { sha256: expectedSha256 } : {}) }) : undefined;
    if (verified) return { blob, sha256: verified.sha256 };
    const sha256 = await verifyBlob(blob, expectedSha256 ? { ...source, sha256: expectedSha256 } : source, 'Procedure PDF');
    return { blob, sha256 };
  } catch (error) {
    await discardDownloadedFile(blob);
    throw error;
  }
}

function requirePdfResponse(response: Response): void {
  if (response.status !== 200 || !response.headers.get('content-type')?.toLowerCase().includes('application/pdf')) {
    throw new InvalidDataError('Procedure response is not a complete PDF');
  }
}

export function procedureFetchUrl(url: string, proxyRoot = import.meta.env?.VITE_ZLAYERS_PROCEDURE_PROXY_ROOT?.trim() || '/faa-procedures'): string {
  const parsed = new URL(url);
  // Only this fixed FAA path is proxied; never create a general URL relay.
  const path = parsed.origin === 'https://aeronav.faa.gov'
    ? parsed.pathname.match(/^\/d-tpp\/(\d{4}\/[-\w]+\.pdf)$/i)?.[1] : undefined;
  return path ? `${proxyRoot.replace(/\/+$/, '')}/${path}${parsed.search}` : url;
}
