import { readOfflineRecord, writeOfflineRecord } from './database';

export const CACHE_ACCESS_PREFIX = 'cache-access:';
const recentlyUsed = new Map<string, number>();
const WRITE_INTERVAL_MS = 60_000;

export function cacheAccessKey(cache: string, url: string): string {
  return `${CACHE_ACCESS_PREFIX}${cache}:${new URL(url, globalThis.location?.href).href}`;
}

/** Track whole-file use, never individual tiles. Metadata failure must not break a read. */
export async function noteCacheAccess(cache: string, url: string, now = Date.now()): Promise<void> {
  try {
    const key = cacheAccessKey(cache, url);
    if (now - (recentlyUsed.get(key) ?? 0) < WRITE_INTERVAL_MS) return;
    recentlyUsed.set(key, now);
    if (recentlyUsed.size > 4_096) recentlyUsed.delete(recentlyUsed.keys().next().value!);
    await writeOfflineRecord(key, now);
  } catch { /* Storage may be unavailable; cleanup treats unknown ages conservatively. */ }
}

export async function cacheLastUsed(cache: string, url: string): Promise<number | undefined> {
  const value = await readOfflineRecord(cacheAccessKey(cache, url));
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
