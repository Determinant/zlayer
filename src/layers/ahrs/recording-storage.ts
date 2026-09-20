import { offlineRecords, readOfflineRecord, writeOfflineRecords } from '../../core/storage/database';

export type RecordingInfo = {
  version: 1;
  id: string;
  startedAt: number;
  updatedAt: number;
  status: 'recording' | 'complete';
  chunks: number;
  events: number;
  bytes: number;
};
export type RecordingStorage = {
  save(info: RecordingInfo, chunk?: Blob): Promise<void>;
  list(): Promise<RecordingInfo[]>;
  download(info: RecordingInfo): Promise<Blob>;
  remove(id: string): Promise<void>;
};
const PREFIX = 'ahrs-recording:';
const chunkPrefix = (id: string) => `ahrs-samples:${id}:`;
const chunkKey = (id: string, index: number) => `${chunkPrefix(id)}${index}`;
export const RECORDING_MIME = 'application/x-ndjson';

/** Metadata and each bounded chunk commit atomically in the app's resettable DB. */
export const recordingStorage: RecordingStorage = {
  async save(info, chunk) {
    const key = `${PREFIX}${info.id}`;
    const entries: Array<[string, unknown]> = [[key, info]];
    if (chunk) entries.push([chunkKey(info.id, info.chunks - 1), chunk]);
    // Only the first chunk may create a session. A later flush, including one
    // from another window, must not recreate a session deleted in the meantime.
    await writeOfflineRecords(entries, chunk && info.chunks === 1 ? {} : { requireKey: key });
  },
  async list() {
    const records = await offlineRecords(PREFIX);
    return records.filter((value): value is RecordingInfo => {
      const record = value as RecordingInfo | null;
      return record?.version === 1 && typeof record.id === 'string' &&
        Number.isFinite(record.startedAt) && Number.isSafeInteger(record.chunks) && record.chunks > 0;
    }).sort((a, b) => b.startedAt - a.startedAt);
  },
  async download(info) {
    const parts: Blob[] = [];
    for (let index = 0; index < info.chunks; index++) {
      const chunk = await readOfflineRecord(chunkKey(info.id, index));
      if (!(chunk instanceof Blob)) throw new Error('This recording is incomplete in storage.');
      parts.push(chunk);
    }
    // An active/interrupted recording is a valid file containing its committed prefix.
    return new Blob(parts, { type: RECORDING_MIME });
  },
  async remove(id) {
    // Delete by prefix, not a possibly stale chunk count from the list view.
    await writeOfflineRecords([[`${PREFIX}${id}`, undefined]], { removePrefixes: [chunkPrefix(id)] });
  },
};

export function recordingFilename(info: RecordingInfo): string {
  return `zlayer-ahrs-${new Date(info.startedAt).toISOString().replaceAll(':', '-')}-${info.id.slice(0, 8)}.jsonl`;
}
