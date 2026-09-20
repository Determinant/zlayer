import { isDownloadActive, type Download } from '../offline/downloads';
import { formatBytes } from '../offline/storage';

export type RegionOperation = 'start' | 'remove';
type ProgressPresentation = {
  label: 'download' | 'file check' | 'final check';
  value: number | undefined;
  message: string;
};
type DownloadPresentation = {
  status: string | undefined;
  action: { kind: 'start' | 'pause'; label: string; disabled: boolean };
  progress: ProgressPresentation | undefined;
};

/** Keep each phase's badge, action and progress together. This adds no UI state. */
export function presentDownload(job: Download | undefined, pending: RegionOperation | undefined): DownloadPresentation {
  const present = (status: string | undefined, label: string, progress?: ProgressPresentation): DownloadPresentation => ({
    status: pending === 'remove' ? 'Removing…' : status,
    action: { kind: job && isDownloadActive(job) ? 'pause' : 'start', label, disabled: job?.state === 'pausing' },
    progress,
  });
  if (!job) {
    const status = pending === 'start' ? 'Starting…' : pending === 'remove' ? 'Removing…' : undefined;
    return present(status, status ?? 'Download', pending === 'start'
      ? { label: 'download', value: undefined, message: 'Preparing download…' } : undefined);
  }

  const files = `${job.files.length.toLocaleString()} ${job.files.length === 1 ? 'file' : 'files'}`;
  const saved: ProgressPresentation = { label: 'download', value: job.completedFiles,
    message: `${job.completedFiles.toLocaleString()} of ${files} saved · ${formatBytes(job.completedBytes)}` };
  switch (job.state) {
    case 'complete':
      return present('Saved', 'Verify / update');
    case 'paused':
      return present('Paused', 'Resume', { ...saved, message: job.completedFiles === job.files.length
        ? 'Files saved. Resume to finish the offline check.' : saved.message });
    case 'error':
      return present('Needs attention', 'Retry', job.checkedFiles === undefined
        ? { label: 'download', value: undefined, message: 'Offline availability could not be checked.' } : saved);
    case 'verifying':
      return present('Checking files', 'Pause', { label: 'file check', value: job.checkedFiles,
        message: 'Checking existing files so only missing files are downloaded…' });
    case 'preparing':
      return present('Preparing', 'Pause', { label: 'download', value: undefined,
        message: 'Preparing the app and reference data for offline use…' });
    case 'downloading':
      return present('Downloading', 'Pause', saved);
    case 'pausing':
      return present('Pausing', 'Pause', { label: 'download', value: undefined,
        message: 'Pausing safely. Any file already downloading will finish first.' });
    case 'finalizing':
      return present('Final check', 'Pause', job.checkedFiles === job.files.length
        ? { label: 'final check', value: undefined, message: 'Files checked. Confirming offline data and finishing the save…' }
        : { label: 'final check', value: job.checkedFiles,
          message: `Download finished. Checking offline availability: ${(job.checkedFiles ?? 0).toLocaleString()} of ${files} checked.` });
  }
}
