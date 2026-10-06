import { isNotamAirportSnapshot, isNotamSnapshot, isTfrSnapshot, notamQueryKey, type NotamAirportSnapshot, type NotamSnapshot, type TfrSnapshot } from '@zlayer/contracts';
import { createPluginStorage } from '../../core/storage/plugin-storage';

export const MAX_QUERY_SNAPSHOTS = 24;
export const pluginStorage = createPluginStorage('notams', undefined, { maxRecordBytes: 2 * 1024 * 1024 });
export const airportSnapshots = pluginStorage.record<NotamAirportSnapshot[]>('airport-snapshots', {
  version: 1, fallback: [],
  decode: value => Array.isArray(value) && value.length <= MAX_QUERY_SNAPSHOTS && value.every(isNotamAirportSnapshot) ? value : undefined,
  encode: value => value,
});
/** New mixed-scope cache; retain the legacy airport record for older clients. */
export const querySnapshots = pluginStorage.record<NotamSnapshot[]>('query-snapshots', {
  version: 1, fallback: [],
  decode: value => Array.isArray(value) && value.length <= MAX_QUERY_SNAPSHOTS && value.every(isNotamSnapshot) ? value : undefined,
  encode: value => value,
});
export const tfrSnapshot = pluginStorage.record<TfrSnapshot | null>('tfr-snapshot', {
  version: 1, fallback: null,
  decode: value => value === null || isTfrSnapshot(value) ? value : undefined,
  encode: value => value,
});

export const notamSnapshotTimeValid = (snapshot: NotamSnapshot, now: number) =>
  (snapshot.feed.checkedAt ?? Infinity) <= now + 30_000;

/** Merge only the newly retrieved query, never the window's older in-memory copy of other queries. */
export function mergeNotamSnapshots(saved: NotamSnapshot[], incoming: NotamSnapshot, now: number): NotamSnapshot[] {
  const snapshots = new Map<string, NotamSnapshot>();
  for (const snapshot of [incoming, ...saved]) {
    if (!notamSnapshotTimeValid(snapshot, now)) continue;
    const key = notamQueryKey(snapshot.query), previous = snapshots.get(key);
    if (!previous || previous.feed.environment === snapshot.feed.environment &&
      (snapshot.feed.checkedAt ?? 0) > (previous.feed.checkedAt ?? 0)) snapshots.set(key, snapshot);
  }
  const values: NotamSnapshot[] = []; let bytes = 4; // JSON array brackets, in UTF-16 bytes.
  for (const snapshot of snapshots.values()) {
    if (values.length >= MAX_QUERY_SNAPSHOTS) break;
    const size = JSON.stringify(snapshot).length * 2 + (values.length ? 2 : 0);
    if (bytes + size > 1_900_000) continue;
    bytes += size; values.push(snapshot);
  }
  return values;
}
