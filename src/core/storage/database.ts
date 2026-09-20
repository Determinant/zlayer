// Metadata and bounded local records. Complete chart/PDF bytes belong in Cache Storage.
let opening: Promise<IDBDatabase> | undefined;

function database(): Promise<IDBDatabase> {
  if (opening) return opening;
  const request = new Promise<IDBDatabase>((resolve, reject) => {
    const connection = indexedDB.open('zlayer-offline', 1);
    let expired = false;
    const timeout = setTimeout(() => {
      expired = true;
      reject(new Error('Offline storage is blocked by another app window'));
    }, 5_000);
    connection.onupgradeneeded = () => connection.result.createObjectStore('records');
    connection.onerror = () => { clearTimeout(timeout); reject(connection.error); };
    connection.onsuccess = () => {
      clearTimeout(timeout);
      const db = connection.result;
      if (expired) { db.close(); return; }
      const reset = () => { if (opening === request) opening = undefined; };
      db.onclose = reset;
      db.onversionchange = () => { db.close(); reset(); };
      resolve(db);
    };
  });
  opening = request;
  void request.catch(() => { if (opening === request) opening = undefined; });
  return request;
}

export async function readOfflineRecord(key: string): Promise<unknown> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('records');
    transaction.onabort = () => reject(transaction.error ?? new Error('Offline storage transaction aborted'));
    const request = transaction.objectStore('records').get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function writeOfflineRecord(key: string, value: unknown): Promise<void> {
  return writeOfflineRecords([[key, value]]);
}

/** Commit related records/removals together. An optional existence guard is
 * checked in the same transaction, so an append cannot revive a deleted group. */
export async function writeOfflineRecords(entries: ReadonlyArray<readonly [string, unknown]>, options: {
  requireKey?: string;
  removePrefixes?: readonly string[];
} = {}): Promise<void> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('records', 'readwrite');
    const records = transaction.objectStore('records');
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('Offline storage transaction aborted'));
    transaction.onerror = () => reject(transaction.error);
    const commit = () => {
      try {
        for (const [key, value] of entries) {
          if (value === undefined) records.delete(key);
          else records.put(value, key);
        }
        for (const prefix of options.removePrefixes ?? []) records.delete(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    };
    if (options.requireKey === undefined) commit();
    else {
      const request = records.getKey(options.requireKey);
      request.onsuccess = () => {
        if (request.result !== undefined) commit();
        else {
          transaction.abort();
          reject(new Error('Saved data was deleted'));
        }
      };
    }
  });
}

export async function offlineRecords(prefix: string): Promise<unknown[]> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('records');
    transaction.onabort = () => reject(transaction.error ?? new Error('Offline storage transaction aborted'));
    const request = transaction.objectStore('records')
      .getAll(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Enumerate record identities without copying their potentially large catalog values. */
export async function offlineRecordKeys(prefix: string): Promise<string[]> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('records');
    transaction.onabort = () => reject(transaction.error ?? new Error('Offline storage transaction aborted'));
    const request = transaction.objectStore('records')
      .getAllKeys(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
    request.onsuccess = () => resolve(request.result.filter((key): key is string => typeof key === 'string'));
    request.onerror = () => reject(request.error);
  });
}
