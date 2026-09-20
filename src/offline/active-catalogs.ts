import { isCatalogResponse, type CatalogResponse } from '@zlayer/contracts';
import { offlineRecordKeys, readOfflineRecord, writeOfflineRecord } from '../core/storage/database';

const PREFIX = 'active-catalog:';
const FILES_PREFIX = 'active-files:';
let pruning: Promise<void> | undefined;

/** A live Web Lock identifies an open view, including background/frozen tabs.
 * Browser termination releases the lock, so crashed tabs cannot pin files forever. */
export function retainActiveCatalog(catalog: CatalogResponse): () => void {
  return retain(PREFIX, catalog);
}

export function retainActiveFiles(urls: string[]): () => void {
  return retain(FILES_PREFIX, urls);
}

function retain(prefix: string, value: unknown): () => void {
  if (!navigator.locks) return () => {};
  const key = `${prefix}${crypto.randomUUID()}`;
  let release!: () => void;
  let closed = false;
  const lifetime = new Promise<void>(resolve => { release = resolve; });
  // Hold the lock before publishing, through deletion: cleanup must not mistake
  // a record being written by another tab for an abandoned one.
  void navigator.locks.request(key, async () => {
    if (closed) return;
    try { await writeOfflineRecord(key, value); await lifetime; }
    finally { await writeOfflineRecord(key, undefined); }
  }).catch(() => {});
  void pruneInactiveRecords().catch(() => {});
  return () => { closed = true; release(); };
}

/** Closing a page releases its locks without running promise cleanup. Reclaim
 * those metadata records on the next view, including during an offline launch. */
export function pruneInactiveRecords(): Promise<void> {
  if (!navigator.locks) return Promise.resolve();
  if (!pruning) pruning = navigator.locks.request('zlayer-active-record-cleanup', { ifAvailable: true }, async lock => {
    if (!lock) return;
    for (const prefix of [PREFIX, FILES_PREFIX]) for (const key of await offlineRecordKeys(prefix)) {
      await navigator.locks.request(key, { ifAvailable: true }, async available => {
        if (available) await writeOfflineRecord(key, undefined);
      });
    }
  }).finally(() => { pruning = undefined; });
  return pruning;
}

export async function activeCatalogs(): Promise<CatalogResponse[]> {
  const locks = await navigator.locks.query();
  const values = await Promise.all((locks.held ?? []).filter(lock => lock.name?.startsWith(PREFIX))
    .map(lock => readOfflineRecord(lock.name!)));
  if (values.some(value => !isCatalogResponse(value))) throw new Error('An active catalog could not be read; cache cleanup deferred');
  return values.filter(isCatalogResponse);
}


export async function activeFileUrls(): Promise<string[]> {
  const locks = await navigator.locks.query();
  const values = await Promise.all((locks.held ?? []).filter(lock => lock.name?.startsWith(FILES_PREFIX))
    .map(lock => readOfflineRecord(lock.name!)));
  if (values.some(value => !Array.isArray(value) || value.some(url => typeof url !== 'string'))) {
    throw new Error('Active files could not be read; cache cleanup deferred');
  }
  return (values as string[][]).flat();
}
