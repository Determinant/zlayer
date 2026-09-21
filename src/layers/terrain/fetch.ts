import { withAbort } from '../../core/data/abort';

/** A short retry handles transient tile failures within one overall deadline. */
export async function fetchElevation(url: string, signal: AbortSignal): Promise<Response> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  for (let attempt = 0; ; attempt++) {
    deadline.throwIfAborted();
    try {
      const response = await fetch(url, { signal: deadline });
      if (response.ok) return response;
      await response.body?.cancel();
      if (![408, 429, 500, 502, 503, 504].includes(response.status) || attempt === 2) {
        throw new Error(`Terrain elevation unavailable (${response.status})`);
      }
    } catch (error) {
      deadline.throwIfAborted();
      if (!(error instanceof TypeError) || attempt === 2) throw error;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await withAbort(new Promise<void>(resolve => { timer = setTimeout(resolve, 250 * 2 ** attempt); }), deadline); }
    finally { clearTimeout(timer); }
  }
}
