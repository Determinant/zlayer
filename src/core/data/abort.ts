/** Stop waiting for shared/read-only work without cancelling its other consumers. */
export async function withAbort<T>(request: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    const value = await Promise.race([cancelled, request]);
    // A ready cache result can win the race just before cancellation arrives.
    signal.throwIfAborted();
    return value;
  } finally { signal.removeEventListener('abort', abort); }
}
