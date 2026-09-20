import { resourceErrorCode } from '../core/data/errors';
import { withAbort } from '../core/data/abort';

export const DOWNLOAD_RETRY_DELAYS = [1_000, 2_000, 4_000] as const;

/** Called only for file transfers, never for cache inspection or metadata writes. */
export function isRetryableDownloadError(error: unknown): boolean {
  const code = resourceErrorCode(error);
  if (code !== undefined) return code === 'request';
  // File transfers use their own timeout, not the region's pause signal. A body
  // interrupted by that timeout can report AbortError instead of TimeoutError.
  return error instanceof TypeError || error instanceof DOMException &&
    ['TimeoutError', 'AbortError', 'NetworkError'].includes(error.name);
}

export async function waitForDownloadRetry(delay: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await withAbort(new Promise<void>(resolve => { timer = setTimeout(resolve, delay); }), signal);
  } finally { clearTimeout(timer); }
}
