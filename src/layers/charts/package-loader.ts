import { transfer } from 'comlink';
import { WorkerClient } from '../../core/data/worker-client';
import { InvalidDataError, isResourceErrorCode, ResourceError } from '../../core/data/errors';

import { createPackageReader, MAX_FAST_PACKAGE_BYTES } from './package-reader';
import type { PackageDecoder } from './package-worker';

let decoder: WorkerClient<PackageDecoder> | undefined;

export async function openPackageReader(url: string) {
  // The controlling service worker coalesces, verifies, and persists this full
  // GET before returning bytes. Do not replace it with per-tile/range fetches.
  const response = await fetch(url);
  if (response.status !== 200) {
    const code = response.headers.get('x-zlayer-error-code');
    throw new ResourceError(isResourceErrorCode(code) ? code : response.status === 507 ? 'storage' : 'request',
      `Unable to load chart package: ${response.status}`);
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_FAST_PACKAGE_BYTES || bytes.byteLength !== Number(new URL(url).searchParams.get('bytes'))) {
    throw new InvalidDataError('Chart package size mismatch');
  }
  if (!decoder || decoder.retired) decoder = new WorkerClient<PackageDecoder>(
    new Worker(new URL('./package-worker.ts', import.meta.url), { type: 'module' }),
    'Unable to initialize chart package reader', { retireOnError: true });
  return createPackageReader(await decoder.call(remote => remote.decode(transfer(bytes, [bytes]))));
}
