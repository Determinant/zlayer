import { WorkerClient } from '../../core/data/worker-client';
import { removeExportFiles } from '../../core/storage/export-file';
import type { RecordingExportWorker } from './recording-export.worker';
import { recordingFilename, type RecordingExportFormat, type RecordingInfo } from './recording-storage';

type Download = { key: string; url: string; inMemory: boolean; renew(): void; dispose(): void };
let recent: Download | undefined;
let preparing = false;

function openDownload(url: string, filename: string): void {
  const link = document.createElement('a');
  link.href = url; link.download = filename;
  document.body.append(link);
  try { link.click(); } finally { link.remove(); }
}

function retainDownload(key: string, name: string, blob: Blob, inMemory: boolean): Download {
  const url = URL.createObjectURL(blob);
  let timer: ReturnType<typeof setTimeout>;
  const download: Download = { key, url, inMemory,
    renew() { clearTimeout(timer); timer = setTimeout(() => download.dispose(), 300_000); },
    dispose() {
      clearTimeout(timer); URL.revokeObjectURL(url);
      if (recent === download) recent = undefined;
      void removeExportFiles(name).catch(() => {});
    },
  };
  download.renew();
  return download;
}

export async function downloadRecording(info: RecordingInfo, format: RecordingExportFormat, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (preparing) throw new Error('A recording download is already being prepared.');
  // Stored chunks are immutable. Reuse exactly this committed prefix, including
  // while capture appends new chunks or a user repeats the same download.
  const key = `${info.id}:${info.chunks}:${format}`;
  if (recent?.key === key) {
    recent.renew(); openDownload(recent.url, recordingFilename(info, format)); return;
  }
  // Keep at most one fallback payload, and free it before allocating another.
  // Disk-backed downloads retain their five-minute window for mobile Save/Share.
  if (recent?.inMemory) recent.dispose();
  const name = `${Date.now()}-${crypto.randomUUID()}.${format}`;
  preparing = true;
  let client: WorkerClient<RecordingExportWorker> | undefined;
  let download: Download | undefined;
  const abort = () => client?.dispose();
  signal.addEventListener('abort', abort, { once: true });
  try {
    client = new WorkerClient<RecordingExportWorker>(new Worker(new URL('./recording-export.worker.ts', import.meta.url),
      { type: 'module' }), 'The recording export stopped. Please try again.');
    signal.throwIfAborted();
    const file = await client.call(remote => remote.prepare(info, format, name));
    signal.throwIfAborted();
    download = retainDownload(key, name, file.blob, file.inMemory);
    recent = download;
    openDownload(download.url, recordingFilename(info, format));
  } catch (error) {
    download?.dispose();
    client?.dispose();
    await removeExportFiles(name).catch(() => {});
    signal.throwIfAborted();
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    client?.dispose();
    preparing = false;
  }
}
