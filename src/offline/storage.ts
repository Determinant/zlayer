import type { OfflineFile } from './downloads';

import { CHART_CACHE, PDF_CACHE } from '../core/storage/cache-names';
import { discardResponseBody } from '../core/storage/response';
import { verificationReceipt } from '../core/storage/verification-receipt';
import { openFileCache } from '../core/storage/download-file';
import { InvalidDataError } from '../core/data/errors';

export const fileCache = (file: OfflineFile) => file.kind === 'chart' || file.kind === 'terrain' ? CHART_CACHE : PDF_CACHE;

export async function cachedFileBytes(file: OfflineFile): Promise<number | undefined> {
  let response: Response | undefined;
  try {
    response = await (await openFileCache(fileCache(file))).match(file.url);
    if (response?.status !== 200) return undefined;
    if (file.kind === 'faa-pdf' && response.headers.get('content-type') !== 'application/pdf') return undefined;
    return verificationReceipt(response.headers, file)?.byteLength;
  } catch (error) {
    if (error instanceof InvalidDataError) return undefined;
    throw error;
  } finally { discardResponseBody(response); }
}

export type StorageStatus = {
  usage: number | undefined;
  quota: number | undefined;
  persistent: boolean;
  persistenceSupported: boolean;
};

export async function storageStatus(requestPersistence = false): Promise<StorageStatus> {
  const storage = navigator.storage;
  const persistenceSupported = typeof storage?.persist === 'function';
  const [estimate, persistent] = await Promise.all([
    storage?.estimate?.().catch((): StorageEstimate => ({})) ?? {},
    (requestPersistence && persistenceSupported ? storage.persist() : storage?.persisted?.())
      ?.catch(() => false) ?? false,
  ]);
  return { usage: estimate.usage, quota: estimate.quota, persistent, persistenceSupported };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const unit = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** unit).toFixed(unit === 1 ? 0 : 1)} ${['B', 'KiB', 'MiB', 'GiB'][unit]}`;
}
