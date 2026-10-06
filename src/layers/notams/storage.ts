import { isNotamAirportSnapshot, isTfrSnapshot, notamAirportKey, type NotamAirportSnapshot, type TfrSnapshot } from '@zlayer/contracts';
import { createPluginStorage } from '../../core/storage/plugin-storage';

export const MAX_AIRPORT_SNAPSHOTS = 24;
export const pluginStorage = createPluginStorage('notams', undefined, { maxRecordBytes: 2 * 1024 * 1024 });
export const airportSnapshots = pluginStorage.record<NotamAirportSnapshot[]>('airport-snapshots', {
  version: 1, fallback: [],
  decode: value => Array.isArray(value) && value.length <= MAX_AIRPORT_SNAPSHOTS && value.every(isNotamAirportSnapshot) ? value : undefined,
  encode: value => value,
});
export const tfrSnapshot = pluginStorage.record<TfrSnapshot | null>('tfr-snapshot', {
  version: 1, fallback: null,
  decode: value => value === null || isTfrSnapshot(value) ? value : undefined,
  encode: value => value,
});

export const notamSnapshotTimeValid = (snapshot: NotamAirportSnapshot, now: number) =>
  (snapshot.feed.checkedAt ?? Infinity) <= now + 30_000;

/** Merge only the newly retrieved airport, never the window's older in-memory copy of other airports. */
export function mergeAirportSnapshots(saved: NotamAirportSnapshot[], incoming: NotamAirportSnapshot, now: number): NotamAirportSnapshot[] {
  const snapshots = new Map<string, NotamAirportSnapshot>();
  for (const snapshot of [incoming, ...saved]) {
    if (!notamSnapshotTimeValid(snapshot, now)) continue;
    const key = notamAirportKey(snapshot.query), previous = snapshots.get(key);
    if (!previous || previous.feed.environment === snapshot.feed.environment &&
      (snapshot.feed.checkedAt ?? 0) > (previous.feed.checkedAt ?? 0)) snapshots.set(key, snapshot);
  }
  const values: NotamAirportSnapshot[] = []; let bytes = 4; // JSON array brackets, in UTF-16 bytes.
  for (const snapshot of snapshots.values()) {
    if (values.length >= MAX_AIRPORT_SNAPSHOTS) break;
    const size = JSON.stringify(snapshot).length * 2 + (values.length ? 2 : 0);
    if (bytes + size > 1_900_000) continue;
    bytes += size; values.push(snapshot);
  }
  return values;
}
