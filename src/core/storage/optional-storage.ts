import { withAbort } from '../data/abort';

export class StorageTimeoutError extends Error {
  constructor() { super('Optional storage timed out'); }
}

/** Cache Storage cannot cancel an operation. Stop waiting, dispose late reads,
 * and let mutation callers keep their lock until the actual operation settles. */
export async function optionalStorage<T>(work: (signal: AbortSignal) => Promise<T>, signal: AbortSignal,
  discard?: (value: T) => void): Promise<T> {
  signal.throwIfAborted();
  const deadline = new AbortController(), combined = AbortSignal.any([signal, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(new StorageTimeoutError()), 10_000);
  const result = Promise.resolve().then(() => { combined.throwIfAborted(); return work(combined); });
  try { return await withAbort(result, combined); }
  catch (error) {
    // Also covers cancellation between resolution and delivery to the caller.
    if (discard) void result.then(discard, () => {});
    throw error;
  }
  finally { clearTimeout(timer); }
}
