import type { ReferenceResource } from '../core/data/references';
import type { Bounds, CatalogResponse } from '@zlayer/contracts';
import { isActivated } from './region-selection';
import { withAbort } from '../core/data/abort';
import { snapshotFilesIncluded } from './plan-records';
import { DOWNLOAD_RETRY_DELAYS, isRetryableDownloadError, waitForDownloadRetry } from './download-retry';

export type OfflineFile = {
  url: string;
  byteLength: number;
  sha256: string;
  kind: 'chart' | 'pdf';
} | {
  // FAA individual-only plates have a cycle/export URL, but no published size/hash.
  // Their actual size and local integrity receipt live with the verified cached PDF.
  url: string;
  kind: 'faa-pdf';
  byteLength?: never;
  sha256?: never;
};
export type DownloadPlan = {
  id: string;
  regionId: string;
  title: string;
  revision: string;
  files: OfflineFile[];
  references: ReferenceResource[];
  bounds?: Bounds[];
  // The planner supplies metadata; persistence stores one shared immutable snapshot.
  catalog?: CatalogResponse;
  snapshotId?: string;
  completedAt?: number;
  // Keep the last selection usable while its replacement is incomplete.
  previous?: DownloadPlan;
};
export type DownloadState = 'paused' | 'preparing' | 'verifying' | 'downloading' | 'finalizing' | 'pausing' | 'complete' | 'error';
type DownloadProgress = {
  completedBytes: number;
  completedFiles: number;
};
type DownloadAvailability = { progress: DownloadProgress; ready: boolean };
export type Download = DownloadPlan & DownloadProgress & {
  state: DownloadState;
  checkedFiles?: number;
  error?: string;
};
export type DownloadBackend = {
  list: (requireReadable?: boolean) => Promise<DownloadPlan[]>;
  save: (plan: DownloadPlan) => Promise<DownloadPlan | void>;
  complete?: (plan: DownloadPlan) => Promise<DownloadPlan | void>;
  forget: (id: string) => Promise<void>;
  cachedBytes: (file: OfflineFile) => Promise<number | undefined>;
  referencesReady: (plan: DownloadPlan) => Promise<boolean>;
  prepare: (plan: DownloadPlan, signal: AbortSignal) => Promise<DownloadPlan | void>;
  download: (file: OfflineFile) => Promise<void>;
  remove: (file: OfflineFile) => Promise<void>;
  exclusive: (work: () => Promise<void>) => Promise<void>;
};

/** Foreground, resumable queue. The durable files, not a progress receipt, prove completion. */
export class RegionDownloads {
  #jobs = new Map<string, Download>();
  #listeners = new Set<() => void>();
  #snapshot: readonly Download[] = [];
  #active: string | undefined;
  #controller: AbortController | undefined;
  #operation = false;
  #restoring: Promise<void> | undefined;
  constructor(readonly backend: DownloadBackend) {}
  snapshot = (): readonly Download[] => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };
  #publish(job?: Download): void {
    if (job && job.id === this.#active && this.#controller?.signal.aborted && isDownloadActive(job)) {
      job = { ...job, state: 'pausing' };
    }
    if (job) this.#jobs.set(job.id, job);
    this.#snapshot = [...this.#jobs.values()];
    for (const listener of this.#listeners) listener();
  }
  restore(): Promise<void> {
    if (this.#restoring) return this.#restoring;
    if (this.#operation) return Promise.resolve();
    this.#operation = true;
    const request = (async () => {
      const plans = await this.backend.list();
      const restored = new Map<string, Download>();
      // Regions share national reference files. Validate them once per check,
      // but never reuse that readiness after a later eviction or schema update.
      const references = new Map<string, Promise<boolean>>();
      for (const plan of plans) {
        try {
          const { progress, ready } = await this.#inspect(plan, references);
          restored.set(plan.id, { ...plan, ...progress, state: ready && isActivated(plan) ? 'complete' : 'paused' });
        } catch (error) {
          // A failed read must neither hide this selection nor prevent checking others.
          restored.set(plan.id, { ...plan, completedBytes: 0, completedFiles: 0, state: 'error',
            error: `Could not check saved data. ${error instanceof Error ? error.message : 'Retry when storage is available.'}` });
        }
      }
      this.#jobs = restored;
      this.#publish();
    })().finally(() => { this.#operation = false; this.#restoring = undefined; });
    this.#restoring = request;
    return request;
  }
  async #inspect(plan: DownloadPlan, references = new Map<string, Promise<boolean>>(), options: {
    signal?: AbortSignal; progress?: (progress: DownloadProgress & { checkedFiles: number }) => void;
    file?: (file: OfflineFile, bytes: number | undefined) => void; filesOnly?: boolean;
  } = {}): Promise<DownloadAvailability> {
    const { signal } = options;
    const read = <T>(request: Promise<T>) => signal ? withAbort(request, signal) : request;
    let completedBytes = 0, completedFiles = 0, checkedFiles = 0;
    // Bound cache reads; never open an entire region's blobs concurrently.
    let cursor = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (cursor < plan.files.length) {
        signal?.throwIfAborted();
        const file = plan.files[cursor++]!;
        const bytes = await read(this.backend.cachedBytes(file));
        signal?.throwIfAborted();
        if (bytes !== undefined) { completedBytes += bytes; completedFiles++; }
        checkedFiles++;
        options.file?.(file, bytes);
        options.progress?.({ completedBytes, completedFiles, checkedFiles });
      }
    }));
    // Shared reference readiness does not prove that this selection includes
    // every book named by its snapshot. Check membership before consulting it.
    let complete = plan.files.length > 0 && completedFiles === plan.files.length && snapshotFilesIncluded(plan);
    signal?.throwIfAborted();
    if (complete && !options.filesOnly) {
      const key = JSON.stringify([plan.revision, plan.references]);
      if (!references.has(key)) references.set(key, this.backend.referencesReady(plan));
      complete = await read(references.get(key)!);
    }
    return { progress: { completedBytes, completedFiles }, ready: complete };
  }
  async start(plan: DownloadPlan): Promise<void> {
    if (this.#operation) throw new Error('Pause the current download before starting another region');
    if (!plan.files.length) throw new Error('No files are published for this selection');
    // Resume callers can pass a Download snapshot. Its old state and progress
    // must not overwrite the new operation when plan metadata is staged.
    const { state: _state, error: _error, completedBytes: _bytes, completedFiles: _files,
      checkedFiles: _checked, ...selection } = plan as Download;
    plan = selection;
    this.#operation = true;
    this.#active = plan.id;
    const controller = new AbortController();
    this.#controller = controller;
    const { signal } = controller;
    let job: Download = { ...plan, state: 'verifying', completedBytes: 0, completedFiles: 0, checkedFiles: 0 };
    this.#publish(job);
    try {
      await this.backend.exclusive(async () => {
        plan = await this.backend.save(plan) ?? plan; // Resumable even if this tab is killed next.
        job = { ...job, ...plan };
        signal.throwIfAborted();
        const counted = new Map<string, number>();
        await this.#inspect(plan, undefined, { signal, filesOnly: true,
          file: (file, bytes) => { if (bytes !== undefined) counted.set(file.url, bytes); },
          progress: progress => {
            job = { ...job, ...progress };
            this.#publish(job);
          },
        });
        job = { ...job, state: 'preparing' };
        this.#publish(job);
        signal.throwIfAborted();
        const prepared = await withAbort(this.backend.prepare(plan, signal), signal);
        signal.throwIfAborted();
        if (prepared) plan = await this.backend.save(prepared) ?? prepared;
        job = { ...job, ...plan };
        signal.throwIfAborted();
        job = { ...job, state: 'downloading' };
        this.#publish(job);
        const countFile = (file: OfflineFile, bytes: number | undefined) => {
          const previous = counted.get(file.url);
          if (previous === bytes) return;
          if (bytes === undefined) counted.delete(file.url);
          else counted.set(file.url, bytes);
          job = { ...job, completedFiles: counted.size,
            completedBytes: job.completedBytes - (previous ?? 0) + (bytes ?? 0) };
          this.#publish(job);
        };
        let failure: unknown;
        const transfer = async (files: OfflineFile[], concurrency: number) => {
          let cursor = 0;
          await Promise.all(Array.from({ length: concurrency }, async () => {
            while (!signal.aborted && !failure && cursor < files.length) {
              const file = files[cursor++]!;
              try {
                for (let attempt = 0; ; attempt++) {
                  const cached = await withAbort(this.backend.cachedBytes(file), signal);
                  signal.throwIfAborted();
                  countFile(file, cached);
                  if (cached !== undefined) break;
                  if (signal.aborted || failure) return;
                  try { await this.backend.download(file); }
                  catch (error) {
                    if (!isRetryableDownloadError(error)) throw error;
                    signal.throwIfAborted();
                    if (failure) return;
                    const delay = DOWNLOAD_RETRY_DELAYS[attempt];
                    if (delay === undefined) throw error;
                    await waitForDownloadRetry(delay, signal);
                    continue; // Recheck storage: a timed-out worker may have finished saving.
                  }
                  // A transfer already in flight finishes saving and measuring its file,
                  // even when pause has stopped scheduling new transfers.
                  const bytes = await this.backend.cachedBytes(file);
                  if (bytes === undefined) throw new Error('File was not saved; storage may be full or unavailable');
                  countFile(file, bytes);
                  break;
                }
              } catch (error) {
                if (!signal.aborted || error !== signal.reason) failure ??= error;
              }
            }
          }));
        };
        await transfer(plan.files.filter(file => file.kind === 'chart'), 3);
        // A PDF book can be hundreds of MiB: hash and persist one at a time on phones.
        await transfer(plan.files.filter(file => file.kind !== 'chart'), 1);
        if (failure) throw failure;
        signal.throwIfAborted();
        job = { ...job, state: 'finalizing', checkedFiles: 0 };
        this.#publish(job);
        const { progress, ready } = await this.#inspect(plan, undefined, { signal,
          progress: ({ checkedFiles }) => {
            job = { ...job, checkedFiles };
            this.#publish(job);
          },
        });
        signal.throwIfAborted();
        job = { ...job, ...progress };
        if (!ready) throw new Error(progress.completedFiles < plan.files.length
          ? 'Some files are missing from storage. Retry to download them again.'
          : 'Required offline data could not be confirmed. Retry to finish saving this region.');
        const active = await this.backend.complete?.(plan);
        if (active) plan = active;
        if (!isActivated(plan)) throw new Error('The region could not be marked saved. Retry to finish saving it.');
        job = { ...plan, ...progress, state: 'complete' };
      });
      this.#publish(job);
    } catch (error) {
      this.#publish(signal.aborted && error === signal.reason
        ? { ...job, state: 'paused' }
        : { ...job, state: 'error', error: error instanceof Error ? error.message : 'Download unavailable' });
    } finally {
      // A failed parallel inspection may still have pending reads. Retire their
      // progress callbacks before this job releases the queue or can be retried.
      controller.abort();
      this.#active = undefined;
      this.#controller = undefined;
      this.#operation = false;
      this.#publish();
    }
  }
  pause(id: string): void {
    if (this.#active !== id) return;
    this.#controller?.abort();
    this.#publish(this.#jobs.get(id));
  }
  async remove(id: string): Promise<void> {
    if (this.#operation) throw new Error('Wait for the active download to pause before removing a region');
    const job = this.#jobs.get(id);
    if (!job) return;
    this.#operation = true;
    try {
      await this.backend.exclusive(async () => {
        // Include selections made by other tabs, not only this window's snapshot.
        const plans = await this.backend.list(true);
        const others = plans.filter(plan => plan.id !== id);
        const shared = new Set(others.flatMap(plan => retainedFiles(plan).map(file => file.url)));
        for (const file of retainedFiles(plans.find(plan => plan.id === id) ?? job)) {
          if (!shared.has(file.url)) await this.backend.remove(file);
        }
        await this.backend.forget(id);
      });
      this.#jobs.delete(id);
      this.#publish();
    } finally { this.#operation = false; }
  }
}

export function isDownloadActive(job: Download): boolean {
  return ['preparing', 'verifying', 'downloading', 'finalizing', 'pausing'].includes(job.state);
}

export function downloadBytes(plan: DownloadPlan): number {
  return plan.files.reduce((sum, file) => sum + (file.byteLength ?? 0), 0);
}

export function retainedFiles(plan: DownloadPlan): OfflineFile[] {
  return [...plan.files, ...(plan.previous?.files ?? [])];
}
