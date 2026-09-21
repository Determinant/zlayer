/// <reference lib="webworker" />

export const EXPORT_DIRECTORY = 'zlayer-exports';
export const EXPORT_MEMORY_LIMIT = 8 * 1024 * 1024;
type Sink = { inMemory: boolean; write(bytes: Uint8Array<ArrayBuffer>): void; finish(): Promise<Blob>; abort(): Promise<void> };
type Storage = Pick<StorageManager, 'getDirectory'> | undefined;
export type ExportFile = { blob: Blob; inMemory: boolean };
// WebKit private sessions expose getDirectory(), but reject it with UnknownError.
const unavailable = (error: unknown) => error instanceof DOMException && ['NotSupportedError', 'SecurityError', 'UnknownError'].includes(error.name);
const quotaExceeded = (error: unknown) => error instanceof DOMException && error.name === 'QuotaExceededError';
const absent = (error: unknown) => error instanceof DOMException && error.name === 'NotFoundError';

/** Runs in a dedicated worker. Output goes to disk; older/private browsers get
 * a strictly capped fallback rather than an unbounded whole-recording Blob. */
export async function exportFileSink(name: string, mime: string, storage: Storage = navigator.storage): Promise<Sink> {
  let directory: FileSystemDirectoryHandle | undefined, file: FileSystemFileHandle | undefined;
  try {
    if (storage?.getDirectory) {
      directory = await (await storage.getDirectory()).getDirectoryHandle(EXPORT_DIRECTORY, { create: true });
      // Recover scratch files left by a closed/crashed tab, without touching a
      // concurrent download in another tab. Normal downloads clean up promptly.
      for await (const [entry] of directory.entries()) {
        const created = Number(entry.split('-')[0]);
        if (created > 0 && Date.now() - created > 86_400_000) await directory.removeEntry(entry).catch(() => {});
      }
      file = await directory.getFileHandle(name, { create: true });
      if (file.createSyncAccessHandle) {
        const handle = await file.createSyncAccessHandle();
        try { handle.truncate(0); } catch (error) { handle.close(); throw error; }
        let offset = 0, closed = false;
        const close = () => { if (!closed) { closed = true; handle.close(); } };
        return {
          inMemory: false,
          write(bytes) {
            let written = 0;
            while (written < bytes.length) {
              const count = handle.write(bytes.subarray(written), { at: offset });
              if (count <= 0) throw new Error('The recording export could not be written.');
              written += count; offset += count;
            }
          },
          async finish() {
            handle.flush(); close();
            const blob = await file!.getFile();
            return blob.slice(0, blob.size, mime);
          },
          async abort() { close(); await directory!.removeEntry(name).catch(() => {}); },
        };
      }
    }
  } catch (error) { if (!unavailable(error) && !quotaExceeded(error)) throw error; }
  if (directory && file) await directory.removeEntry(name).catch(() => {});
  return memorySink(mime);
}

function memorySink(mime: string): Sink {
  let parts: Uint8Array<ArrayBuffer>[] = [], size = 0;
  return {
    inMemory: true,
    write(bytes) {
      if (size + bytes.byteLength > EXPORT_MEMORY_LIMIT)
        throw new Error('This export exceeds the 8 MiB memory limit while local file storage is full or unavailable. Free some local storage or enable it, then retry.');
      parts.push(bytes); size += bytes.byteLength;
    },
    async finish() { const blob = new Blob(parts, { type: mime }); parts = []; return blob; },
    async abort() { parts = []; },
  };
}

/** Retry from the saved source after a disk quota failure, including a partial
 * write or failed flush. Close and clean up the disk prefix before the retry. */
export async function writeExportFile(name: string, mime: string, source: () => AsyncIterable<Uint8Array<ArrayBuffer>>,
  storage: Storage = navigator.storage): Promise<ExportFile> {
  let sink = await exportFileSink(name, mime, storage);
  for (;;) {
    try {
      for await (const bytes of source()) sink.write(bytes);
      return { blob: await sink.finish(), inMemory: sink.inMemory };
    } catch (error) {
      await sink.abort();
      if (sink.inMemory || !quotaExceeded(error)) throw error;
      sink = memorySink(mime);
    }
  }
}

/** Also used by the isolated full-reset screen, after workspace workers stop. */
export async function removeExportFiles(name?: string, storage: Storage = navigator.storage): Promise<void> {
  if (!storage?.getDirectory) return;
  let root: FileSystemDirectoryHandle;
  try { root = await storage.getDirectory(); }
  catch (error) { if (unavailable(error)) return; throw error; }
  try {
    if (name) await (await root.getDirectoryHandle(EXPORT_DIRECTORY)).removeEntry(name);
    else await root.removeEntry(EXPORT_DIRECTORY, { recursive: true });
  } catch (error) { if (!absent(error)) throw error; }
}
