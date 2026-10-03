import { ResourceError } from '../data/errors';

export const DOWNLOAD_MEMORY_LIMIT = 8 * 1024 * 1024;
export const DOWNLOAD_WRITE_BYTES = 64 * 1024;
export const DOWNLOAD_DIRECTORY = 'zlayer-downloads';
export const FILE_HEADER = 'x-zlayer-local-file';
export type DiskFile = { directory: FileSystemDirectoryHandle; name: string; committed: boolean; key?: string };
export const downloads = new WeakMap<Blob, DiskFile>();
export const storage = () => globalThis.navigator?.storage;
export const missing = (error: unknown) => error instanceof DOMException && error.name === 'NotFoundError';
export const unavailable = (error: unknown) => error instanceof DOMException &&
  ['NotSupportedError', 'SecurityError', 'UnknownError'].includes(error.name);
export const fileNamePattern = /^\d+-[a-f0-9-]{36}-[a-f0-9]{64}$/;
export const requestUrl = (key: RequestInfo | URL) => key instanceof Request ? key.url : String(key);
export async function keyHash(key: RequestInfo | URL): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(requestUrl(key)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function withFileLock<T>(key: RequestInfo | URL, mode: LockMode, work: () => Promise<T>): Promise<T> {
  // Small in-memory fallback entries also work in browsers without Web Locks.
  if (!globalThis.navigator?.locks) return work();
  return navigator.locks.request(`zlayer-download-key:${await keyHash(key)}`, { mode }, work);
}
export const memoryError = () => new ResourceError('storage',
  'This download needs local file storage to stay within the memory limit. Free device storage, enable site storage, or update your browser, then retry.');
