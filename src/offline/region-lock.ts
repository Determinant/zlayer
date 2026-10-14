/** Let short metadata/cleanup work finish without waiting behind a long transfer. */
export async function withRegionDownloadLock(work: () => Promise<void>): Promise<void> {
  if (!navigator.locks) throw new Error('This browser lacks safe multi-window download coordination; update your browser');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(
    'Offline storage is busy. Retry when the current operation finishes.',
  )), 2_000);
  try {
    await navigator.locks.request('zlayer-region-downloads', { signal: controller.signal }, async () => {
      // Only lock acquisition is bounded; admitted mutations keep the lock until done.
      clearTimeout(timer);
      await work();
    });
  } finally { clearTimeout(timer); }
}
