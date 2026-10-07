import { transfer } from 'comlink';
import { WorkerClient } from '../../core/data/worker-client';
import { isResourceErrorCode, ResourceError } from '../../core/data/errors';
import { createTaskLimiter } from '../../core/data/task-limiter';

import { createPackageReader, MAX_FAST_PACKAGE_BYTES, type PackageTile } from './package-reader';
import type { PackageDecoder } from './package-worker';

import { readManagedFile } from '../../core/storage/file-transfer';

let decoder: WorkerClient<PackageDecoder> | undefined;
const decode = createTaskLimiter(1);
let lifetime = new AbortController();

export function releasePackageDecoder(): void {
  lifetime.abort();
  lifetime = new AbortController();
  decoder?.dispose();
  decoder = undefined;
}

export async function openPackageReader(url: string, signal?: AbortSignal) {
  signal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
  signal.throwIfAborted();
  const activeSignal = signal;
  return decode(activeSignal, async () => {
    // The controlling service worker coalesces, verifies, and persists this full
    // GET before returning bytes. Do not replace it with per-tile/range fetches.
    // The signal belongs to the shared archive open; the service worker retains
    // ownership of any whole-file download after local demand ends.
    const bytes = await readManagedFile(url, { byteLength: Number(new URL(url).searchParams.get('bytes')),
      maximumBytes: MAX_FAST_PACKAGE_BYTES, label: 'Chart package', signal,
      responseError(response) {
        const code = response.headers.get('x-zlayer-error-code');
        return new ResourceError(isResourceErrorCode(code) ? code : response.status === 507 ? 'storage' : 'request',
          `Unable to load chart package: ${response.status}`);
      },
    });
    if (!decoder || decoder.retired) decoder = new WorkerClient<PackageDecoder>(
      new Worker(new URL('./package-worker.ts', import.meta.url), { type: 'module' }),
      'Unable to initialize chart package reader', { retireOnError: true });
    const client = decoder;
    // Only one RPC owns this worker at a time. Cancelling it cannot interrupt
    // another package; queued live consumers start with a fresh worker.
    const cancel = () => client.dispose();
    activeSignal.addEventListener('abort', cancel, { once: true });
    try {
      const rows = await client.call<PackageTile[]>(remote => remote.decode(transfer(bytes, [bytes])));
      activeSignal.throwIfAborted();
      return createPackageReader(rows);
    } catch (error) {
      activeSignal.throwIfAborted();
      throw error;
    } finally { activeSignal.removeEventListener('abort', cancel); }
  });
}
