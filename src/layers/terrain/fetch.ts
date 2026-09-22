import { transferFile } from '../../core/storage/file-transfer';

/** A 256px DEM image has a bounded compressed payload; decoding stays in the worker. */
export function fetchElevation(url: string, signal: AbortSignal): Promise<Blob> {
  return transferFile({ url, signal, label: 'Terrain elevation', maximumBytes: 4 * 1024 * 1024,
    cache: 'default', timeoutMs: 15_000, retries: 2 }, async ({ blob }) => blob);
}
