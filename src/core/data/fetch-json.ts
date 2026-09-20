import { DATA_CACHE } from '../storage/cache-names';
import { noteCacheAccess } from '../storage/cache-access';
import { isRecord } from '@zlayer/contracts';
import { parseGzipJson, type GzipJsonSize } from './gzip-json';
import { InvalidDataError, ResourceError } from './errors';
import { readArtifact } from '../storage/artifacts';
import { discardResponseBody } from '../storage/response';

type FetchJsonOptions<T> = {
  signal?: AbortSignal; revalidate?: boolean; requireCache?: boolean; cacheOnly?: boolean; gzip?: GzipJsonSize;
  // Pin the same response that was validated, avoiding a second cache read,
  // parse/hash and a race with another window replacing the mutable source URL.
  cacheAs?: (value: T) => string;
};

export class JsonResponseError extends ResourceError {
  constructor(message: string, readonly status: number) { super('http', message); }
}

/** Reference documents share one durable cache with regional downloads. Only validated
 * responses enter it; no-store keeps the worker/HTTP cache from replaying a bad export. */
export async function fetchJson<T>(
  url: string,
  guard: (value: unknown) => value is T,
  label: string,
  options: FetchJsonOptions<T> = {},
): Promise<T> {
  options.signal?.throwIfAborted();
  await noteCacheAccess(DATA_CACHE, url);
  const cache = await globalThis.caches?.open(DATA_CACHE).catch(() => undefined);
  const requireCache = options.requireCache || !!options.cacheAs;
  if (requireCache && !cache) throw new ResourceError('storage', 'Reference storage unavailable');
  let savedResponse: Response | undefined;
  const pin = async (body: T, response: Response) => {
    const target = options.cacheAs?.(body);
    if (!target || target === url) return;
    options.signal?.throwIfAborted();
    const copy = response.clone();
    try { await cache!.put(target, copy); }
    finally { discardResponseBody(copy); }
  };
  try {
    const inspected = await readArtifact(cache, url, response => {
      if (options.cacheAs) savedResponse = response.clone();
      return validate(response, guard, label, options.gzip);
    });
    if (inspected.state === 'invalid' && !options.cacheOnly) await cache?.delete(url).catch(() => {});
    const saved = inspected.state === 'ready' ? inspected.value : undefined;
    if (saved === undefined) discardResponseBody(savedResponse);
    const useSaved = async () => {
      if (savedResponse) await pin(saved!, savedResponse);
      return saved!;
    };
    options.signal?.throwIfAborted();
    if (saved !== undefined && !options.revalidate) return await useSaved();
    if (options.cacheOnly) {
      if (saved !== undefined) return await useSaved();
      throw new ResourceError('storage', `${label} has no saved export identity. Verify / update this region.`);
    }
    const timeout = AbortSignal.timeout(30_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response | undefined;
    try {
      response = await fetch(url, { cache: 'no-store', signal });
      const body = await validate(response.clone(), guard, label, options.gzip);
      options.signal?.throwIfAborted();
      await pin(body, response);
      await cache?.put(url, response).catch(error => { if (requireCache) throw error; });
      return body;
    } catch (error) {
      if (saved !== undefined && !options.signal?.aborted) return await useSaved();
      throw error;
    } finally { discardResponseBody(response); }
  } finally { discardResponseBody(savedResponse); }
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

async function validate<T>(response: Response, guard: (value: unknown) => value is T, label: string, gzip?: GzipJsonSize): Promise<T> {
  if (!response.ok) throw await responseError(response, label);
  const body = gzip ? await parseGzipJson(response, gzip) : await parseResponseJson(response, label);
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
