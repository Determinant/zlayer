import { ResourceError } from '../data/errors';
import { boundedBlobStream } from './blob-stream';

const lockName = (name: string) => `zlayer-download-file:${name}`;
const releases = new WeakMap<Blob, () => void>();
const parents = new WeakMap<Blob, Blob>();
const pendingReads = new WeakMap<Promise<unknown>, Blob>();
const collected = new FinalizationRegistry<() => void>(release => release());

/** A slice must keep its original File (and its read lock) alive. Native Blob
 * slices otherwise retain only the backing bytes, not the JavaScript File. */
function slice(this: Blob, ...args: Parameters<Blob['slice']>): Blob {
  const child = Blob.prototype.slice.apply(this, args);
  parents.set(child, this);
  return trackReads(child);
}

function read<T>(blob: Blob, pending: Promise<T>): Promise<T> {
  pendingReads.set(pending, blob);
  return pending.finally(() => { pendingReads.delete(pending); });
}
function trackReads<T extends Blob>(blob: T): T {
  blob.slice = slice;
  blob.arrayBuffer = function () { return read(this, Blob.prototype.arrayBuffer.call(this)); };
  blob.text = function () { return read(this, Blob.prototype.text.call(this)); };
  blob.stream = function () { return boundedBlobStream(this); };
  return blob;
}

/** Keep immutable files readable across replacement/removal in other contexts.
 * Web Locks release on context termination; GC releases unused File handles.
 * The lock callback must not retain the File or its resolved delivery promise. */
export function readLockedFile(directory: FileSystemDirectoryHandle, name: string): Promise<Blob> {
  if (!navigator.locks) return Promise.reject(new ResourceError('storage',
    'Local files require browser window coordination. Update your browser and retry.'));
  const delivery: { resolve?: (blob: Blob) => void; reject?: (error: unknown) => void } = {};
  const result = new Promise<Blob>((resolve, reject) => { delivery.resolve = resolve; delivery.reject = reject; });
  let release!: () => void;
  const lifetime = new Promise<void>(resolve => { release = resolve; });
  void navigator.locks.request(lockName(name), { mode: 'shared' }, () =>
    directory.getFileHandle(name).then(handle => handle.getFile()).then(file => {
      trackReads(file);
      releases.set(file, release);
      collected.register(file, release, file);
      delivery.resolve!(file);
      delete delivery.resolve;
      delete delivery.reject;
      return lifetime;
    }),
  ).catch(error => {
    delivery.reject?.(error);
    delete delivery.resolve;
    delete delivery.reject;
  });
  return result;
}

/** Only for an unclaimed response or an abandoned, unpublished download. An
 * exposed File is owned by its readers and must instead retain its GC lease. */
export function releaseUnusedFile(blob: Blob): void {
  releases.get(blob)?.();
  releases.delete(blob);
  collected.unregister(blob);
}

/** Deletion can wait for existing readers, without blocking cache removal or
 * queueing an exclusive lock ahead of subsequent reads of a published file. */
export async function deleteUnusedFile(directory: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  if (!navigator.locks) return false;
  return navigator.locks.request(lockName(name), { ifAvailable: true }, async lock => {
    if (!lock) return false;
    try { await directory.removeEntry(name); }
    catch (error) { if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error; }
    return true;
  });
}
