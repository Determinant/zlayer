import { InvalidDataError } from '../data/errors';
import { discardResponseBody } from './response';
import { readLockedFile, releaseUnusedFile } from './file-lifetime';
import { pruneDownloadFiles } from './download-cleanup';
import { DOWNLOAD_MEMORY_LIMIT, DOWNLOAD_WRITE_BYTES, DOWNLOAD_DIRECTORY, downloads,
  storage, requestUrl, keyHash, memoryError, type DiskFile } from './download-state';

/** Consume one network chunk at a time, awaiting disk writes before reading more.
 * The fallback has a hard byte ceiling, including unknown/misreported lengths. */
export async function downloadFile(response: Response, options: {
  key: RequestInfo | URL; byteLength?: number | undefined; maximumBytes?: number | undefined;
  label: string; onProgress?: (loaded: number) => void;
}): Promise<Blob> {
  let disk: DiskFile | undefined, writer: FileSystemWritableFileStream | undefined, writing: Blob | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined;
  let parts: Uint8Array<ArrayBuffer>[] = [];
  let loaded = 0;
  try {
    const bound = options.byteLength ?? options.maximumBytes;
    if (bound === undefined || bound > DOWNLOAD_MEMORY_LIMIT) {
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
      if (options.maximumBytes !== undefined && next > options.maximumBytes) {
        throw new InvalidDataError(`${options.label} exceeds its byte limit`);
      }
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

/** Failed verification/publication must not leave a partial or untrusted file. */
export async function discardDownloadedFile(blob: Blob): Promise<void> {
  const disk = downloads.get(blob);
  if (disk && !disk.committed) {
    releaseUnusedFile(blob);
    await disk.directory.removeEntry(disk.name).catch(() => {});
  }
}
