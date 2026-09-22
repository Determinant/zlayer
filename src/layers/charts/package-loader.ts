import { transfer } from 'comlink';
import { WorkerClient } from '../../core/data/worker-client';
import { isResourceErrorCode, ResourceError } from '../../core/data/errors';

import { createPackageReader, MAX_FAST_PACKAGE_BYTES, type PackageTile } from './package-reader';
import type { PackageDecoder } from './package-worker';

import { readManagedFile } from '../../core/storage/file-transfer';

let decoder: WorkerClient<PackageDecoder> | undefined;
const decoding = new Map<WorkerClient<PackageDecoder>, number>();

export function releasePackageDecoder(): void {
  decoder?.dispose();
  decoder = undefined;
  // A retired decoder may still be draining shared reads after a retry created
  // its replacement. Unloading must terminate those workers as well.
  for (const client of decoding.keys()) client.dispose();
}

export async function openPackageReader(url: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
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
  signal?.throwIfAborted();
  if (!decoder || decoder.retired) decoder = new WorkerClient<PackageDecoder>(
    new Worker(new URL('./package-worker.ts', import.meta.url), { type: 'module' }),
    'Unable to initialize chart package reader', { retireOnError: true });
  const client = decoder;
  decoding.set(client, (decoding.get(client) ?? 0) + 1);
  try {
    const rows = await client.call<PackageTile[]>(remote => remote.decode(transfer(bytes, [bytes])));
    signal?.throwIfAborted();
    return createPackageReader(rows);
  } finally {
    const remaining = decoding.get(client)! - 1;
    if (remaining) decoding.set(client, remaining);
    else decoding.delete(client);
  }
}
