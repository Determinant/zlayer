import { InvalidDataError, JsonResponseError } from './errors';
import { discardResponseBody } from '../storage/response';
import { withAbort } from './abort';

/** A shared gateway hit retains the time NOAA was checked, not the time we read its cache. */
export function weatherCheckedAt(response: Response, now: number): number {
  const header = response.headers.get('X-Weather-Checked-At');
  if (header === null) return now;
  const value = Number(header);
  if (!/^\d+$/.test(header) || !Number.isSafeInteger(value) || value <= 0 || value > now + 60_000) {
    throw new InvalidDataError('Weather gateway returned an invalid source-check time');
  }
  return Math.min(value, now);
}

/** Live products own fallback and freshness. This request never reads a cached
 * response, and bounds structured payloads before parsing or accepting them. */
export async function requestJson<T>(url: string, guard: (value: unknown) => value is T,
  label: string, options: { signal?: AbortSignal; maxBytes?: number; headers?: HeadersInit; onResponse?: (response: Response) => void } = {}): Promise<T> {
  const timeout = AbortSignal.timeout(30_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  signal.throwIfAborted();
  const response = await fetch(url, { signal, cache: 'no-store', ...(options.headers ? { headers: options.headers } : {}) });
  if (!response.ok) {
    discardResponseBody(response);
    throw new JsonResponseError(`${label}: ${response.status} ${response.statusText}`.trim(), response.status);
  }
  const value = await readJsonResponse(response, label, options.maxBytes, signal);
  if (!guard(value)) throw new InvalidDataError(`${label} returned an invalid document`);
  options.onResponse?.(response);
  return value;
}

/** Consume an already acquired response with the same decoded-byte bound as requestJson. */
export async function readJsonResponse(response: Response, label: string,
  maxBytes = 4 * 1024 * 1024, signal?: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new InvalidDataError(`${label} returned no document`);
  let bytes = new Uint8Array(0);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await (signal ? withAbort(reader.read(), signal) : reader.read());
      if (done) break;
      length += value.length;
      signal?.throwIfAborted();
      if (length > maxBytes) throw new InvalidDataError(`${label} exceeds the response limit`);
      if (bytes.length < length) {
        const next = new Uint8Array(Math.min(maxBytes, Math.max(64 * 1024, bytes.length * 2, length)));
        next.set(bytes);
        bytes = next;
      }
      bytes.set(value, length - value.length);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  signal?.throwIfAborted();
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes.subarray(0, length))); }
  catch { throw new InvalidDataError(`${label} returned invalid JSON`); }
  return value;
}
