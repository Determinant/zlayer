import { DATA_CACHE } from '../storage/cache-names';
import { noteCacheAccess } from '../storage/cache-access';
import { isRecord } from '@zlayer/contracts';
import { parseGzipJson, type GzipJsonSize } from './gzip-json';
import { InvalidDataError, JsonResponseError, ResourceError } from './errors';
import { readArtifact } from '../storage/artifacts';
import { discardResponseBody } from '../storage/response';
import { optionalStorage } from '../storage/optional-storage';
import { withAbort } from './abort';

type FetchJsonOptions<T> = {
  signal?: AbortSignal; gzip?: GzipJsonSize;
  policy?: 'cache-first' | 'network-first' | 'network-only' | 'cache-only';
  /** Required persistence is independent of the read/fallback policy. */
  requireCache?: boolean;
  // Project an extensible feed onto supported products before validating it.
  // The original response is cached, so later clients can read its added products.
  normalize?: (value: unknown) => unknown;
  // Pin the same response that was validated, avoiding a second cache read,
  // parse/hash and a race with another window replacing the mutable source URL.
  cacheAs?: (value: T) => string;
};

/** Reference documents share one durable cache with regional downloads. Only validated
 * responses enter it; no-store keeps the worker/HTTP cache from replaying a bad export. */
export async function fetchJson<T>(
  url: string,
  guard: (value: unknown) => value is T,
  label: string,
  options: FetchJsonOptions<T> = {},
): Promise<T> {
  const callerSignal = options.signal ?? new AbortController().signal;
  callerSignal.throwIfAborted();
  // Bookkeeping is best effort and must never hold up the actual read.
  void noteCacheAccess(DATA_CACHE, url);
  const cache = await optionalStorage(async () => globalThis.caches?.open(DATA_CACHE), callerSignal)
    .catch(() => { callerSignal.throwIfAborted(); return undefined; });
  const policy = options.policy ?? 'cache-first';
  const requireCache = options.requireCache || !!options.cacheAs;
  if (requireCache && !cache) throw new ResourceError('storage', 'Reference storage unavailable');
  const saved = policy === 'network-only' ? undefined : await optionalStorage(async storageSignal => {
    const inspected = await readArtifact(cache, url, async response => {
      storageSignal.throwIfAborted();
      const copy = options.cacheAs ? response.clone() : undefined;
      try {
        const body = await withAbort(validate(response, guard, label, options.gzip, options.normalize, storageSignal), storageSignal);
        return { body, response: copy };
      } catch (error) { discardResponseBody(copy); throw error; }
    });
    return inspected.state === 'ready' ? inspected.value : undefined;
  }, callerSignal, value => discardResponseBody(value?.response))
    .catch(() => { callerSignal.throwIfAborted(); return undefined; });
  const pin = async (body: T, response: Response) => {
    const target = options.cacheAs?.(body);
    if (!target || target === url) return;
    callerSignal.throwIfAborted();
    const copy = response.clone();
    try { await withAbort(cache!.put(target, copy), callerSignal); }
    finally { discardResponseBody(copy); }
  };
  try {
    // Never delete an inspected URL: another window may already have repaired it.
    // A validated network response replaces the entry atomically with put().
    const useSaved = async () => {
      if (saved?.response) await pin(saved.body, saved.response);
      return saved!.body;
    };
    callerSignal.throwIfAborted();
    if (policy === 'cache-only' || policy === 'cache-first' && saved !== undefined) {
      if (saved !== undefined) return await useSaved();
      throw new ResourceError('storage', `${label} has no saved export identity. Use Update to latest for this region.`);
    }
    const timeout = AbortSignal.timeout(30_000);
    const signal = AbortSignal.any([callerSignal, timeout]);
    let response: Response | undefined;
    try {
      response = await fetch(url, { cache: 'no-store', signal });
      const validation = response.clone();
      let body: T;
      try { body = await withAbort(validate(validation, guard, label, options.gzip, options.normalize, signal), signal); }
      finally { discardResponseBody(validation); }
      callerSignal.throwIfAborted();
      await pin(body, response);
      if (cache) {
        if (requireCache) await withAbort(cache.put(url, response), callerSignal);
        else await optionalStorage(async () => cache.put(url, response!), callerSignal)
          .catch(() => { callerSignal.throwIfAborted(); });
      }
      return body;
    } catch (error) {
      if (saved !== undefined && policy === 'network-first' && !options.signal?.aborted) return await useSaved();
      throw error;
    } finally { discardResponseBody(response); }
  } finally { discardResponseBody(saved?.response); }
}

/** Cache-only verification uses the same guards as loading, without starting a download. */
export async function readCachedJson<T>(
  cache: Pick<Cache, 'match'> | undefined,
  url: string,
  guard: (value: unknown) => value is T,
  label: string,
  gzip?: GzipJsonSize,
): Promise<T | undefined> {
  const result = await readArtifact(cache, url, response => validate(response, guard, label, gzip));
  return result.state === 'ready' ? result.value : undefined;
}

async function validate<T>(response: Response, guard: (value: unknown) => value is T, label: string,
  gzip?: GzipJsonSize, normalize?: (value: unknown) => unknown, signal?: AbortSignal): Promise<T> {
  // JSON consumption locks its body. Propagate cancellation through the stream
  // so a timed-out cached read releases its producer instead of only its caller.
  if (signal && response.body) response = new Response(
    response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal }),
    { status: response.status, statusText: response.statusText, headers: response.headers },
  );
  if (!response.ok) throw await responseError(response, label);
  const parsed = gzip ? await parseGzipJson(response, gzip) : await parseResponseJson(response, label);
  const body = normalize ? normalize(parsed) : parsed;
  if (!guard(body)) throw new InvalidDataError(`${label} returned an invalid document`);
  return body;
}

async function responseError(response: Response, label: string): Promise<Error> {
  const body: unknown = await response.json().catch(() => undefined);
  const error = isRecord(body) ? body.error : undefined;
  const detail = typeof error === 'string'
    ? error
    : `${response.status} ${response.statusText}`.trim();
  return new JsonResponseError(`${label}: ${detail}`, response.status);
}

async function parseResponseJson(response: Response, label: string): Promise<unknown> {
  try {
    const body: unknown = await response.json();
    // Older published/offline packs use the previous product name. Normalize only
    // the identifier; the usual guards still validate every field and cycle.
    if (isRecord(body)) {
      if (body.type === 'AWCPlusAirways') return { ...body, type: 'ZLayerAirways' };
      if (body.type === 'AWCPlusPreferredRoutes') return { ...body, type: 'ZLayerPreferredRoutes' };
    }
    return body;
  } catch (error) {
    if (error instanceof SyntaxError) throw new InvalidDataError(`${label} returned invalid JSON`, { cause: error });
    throw error;
  }
}
