import { offlineRecords, readOfflineRecord, writeOfflineRecords } from '../../core/storage/database';
import { isRecord } from '@zlayer/contracts';

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
  read(info: RecordingInfo): AsyncIterable<Blob>;
  remove(id: string): Promise<void>;
};
const PREFIX = 'ahrs-recording:';
const chunkPrefix = (id: string) => `ahrs-samples:${id}:`;
const chunkKey = (id: string, index: number) => `${chunkPrefix(id)}${index}`;
export const RECORDING_MIME = 'application/x-ndjson';

function isRecordingInfo(value: unknown): value is RecordingInfo {
  if (!isRecord(value)) return false;
  const timestamp = (time: unknown) => typeof time === 'number' && Number.isFinite(time) && Math.abs(time) <= 8.64e15;
  const count = (number: unknown) => typeof number === 'number' && Number.isSafeInteger(number) && number > 0;
  return value.version === 1 && typeof value.id === 'string' && value.id.length > 0 &&
    timestamp(value.startedAt) && timestamp(value.updatedAt) &&
    (value.status === 'recording' || value.status === 'complete') &&
    count(value.chunks) && count(value.events) && count(value.bytes);
}

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
    return records.filter(isRecordingInfo).sort((a, b) => b.startedAt - a.startedAt);
  },
  async *read(info) {
    for (let index = 0; index < info.chunks; index++) {
      const chunk = await readOfflineRecord(chunkKey(info.id, index));
      if (!(chunk instanceof Blob)) throw new Error('This recording is incomplete in storage.');
      yield chunk;
    }
  },
  async remove(id) {
    // Delete by prefix, not a possibly stale chunk count from the list view.
    await writeOfflineRecords([[`${PREFIX}${id}`, undefined]], { removePrefixes: [chunkPrefix(id)] });
  },
};

export type RecordingExportFormat = 'gpx' | 'jsonl';

export function recordingFilename(info: RecordingInfo, format: RecordingExportFormat): string {
  return `zlayer-ahrs-${new Date(info.startedAt).toISOString().replaceAll(':', '-')}-${info.id.slice(0, 8)}.${format}`;
}
