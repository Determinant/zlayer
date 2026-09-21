import { loadProcedureDocument } from '../../src/layers/plates/document-cache';
import { DOWNLOAD_DIRECTORY, openFileCache } from '../../src/core/storage/download-file';
import { PDF_CACHE, fileReceiptCacheName } from '../../src/core/storage/cache-names';
import { cachedFileBytes } from '../../src/offline/storage';

const document = (size: number, sha256: string) => ({
  url: `${location.origin}/large-memory-test.pdf?bytes=${size}&sha256=${sha256}`,
  nativeUrl: `${location.origin}/large-memory-test.pdf`, byteLength: size, sha256,
  pageIndex: 0, source: 'combined-volume' as const,
});

let held: Blob | undefined;
let continueDownload: (() => void) | undefined;
let waiting = false;
export const isWaiting = () => waiting;
export const resume = () => continueDownload?.();
export const readHeld = async () => [...new Uint8Array(await held!.slice(0, 9).arrayBuffer())];
export const releaseHeld = () => { held = undefined; };

export async function save(size: number, sha256: string, retain = false, pause = false) {
  const source = document(size, sha256);
  let sent = 0, requested = 0, maxWrite = 0, loaded = 0;
  const fetch = window.fetch;
  const gate = pause ? new Promise<void>(resolve => { continueDownload = resolve; }) : Promise.resolve();
  const write = FileSystemWritableFileStream.prototype.write;
  FileSystemWritableFileStream.prototype.write = function (data) {
    if (ArrayBuffer.isView(data)) maxWrite = Math.max(maxWrite, data.byteLength);
    return write.call(this, data);
  };
  window.fetch = async (input, init) => {
    if (String(input) !== source.url) return fetch(input, init);
    requested++;
    waiting = pause;
    await gate;
    waiting = false;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === size) { controller.close(); return; }
        const bytes = new Uint8Array(Math.min(256 * 1024, size - sent));
        if (sent === 0) bytes.set(new TextEncoder().encode('%PDF-1.7\n'));
        sent += bytes.length;
        controller.enqueue(bytes);
      },
    }), { headers: { 'content-type': 'application/pdf', 'content-length': String(size) } });
  };
  try {
    const result = await loadProcedureDocument(source, progress => { loaded = progress.loaded; });
    if (retain) held = result.blob.slice(0, result.blob.size).slice(0, result.blob.size);
    const receipt = await (await caches.open(fileReceiptCacheName(PDF_CACHE))).match(source.url);
    return { saved: result.cached, size: result.blob.size, loaded, requested, maxWrite,
      receiptBytes: (await receipt!.blob()).size,
      available: await cachedFileBytes({ ...source, kind: 'pdf' }),
      prefix: await result.blob.slice(0, 9).text() };
  } finally { window.fetch = fetch; FileSystemWritableFileStream.prototype.write = write; continueDownload = undefined; waiting = false; }
}

export async function reopen(size: number, sha256: string) {
  const source = document(size, sha256);
  const fetch = window.fetch;
  window.fetch = async () => { throw new Error('Offline; saved file must be reused'); };
  try {
    const result = await loadProcedureDocument(source);
    return { saved: result.cached, size: result.blob.size, prefix: await result.blob.slice(0, 9).text(),
      tail: [...new Uint8Array(await result.blob.slice(-4).arrayBuffer())] };
  } finally { window.fetch = fetch; }
}

export async function remove(size: number, sha256: string) {
  const source = document(size, sha256);
  await (await openFileCache(PDF_CACHE)).delete(source.url);
  return { remaining: await remainingFiles(), available: await cachedFileBytes({ ...source, kind: 'pdf' }) ?? null };
}

export async function remainingFiles() {
  const files = await (await navigator.storage.getDirectory()).getDirectoryHandle(DOWNLOAD_DIRECTORY);
  const remaining = [];
  for await (const name of files.keys()) remaining.push(name);
  return remaining;
}
