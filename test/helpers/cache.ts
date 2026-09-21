import type { TestContext } from 'node:test';
import { DATA_CACHE } from '../../src/core/storage/cache-names';

/** Keep cache namespaces and response-body ownership, just like browser Cache Storage. */
export function cacheFixture(t: TestContext, name = DATA_CACHE) {
  const stores = new Map<string, ReturnType<typeof memoryCache>>();
  const get = (name: string) => {
    let store = stores.get(name);
    if (!store) { store = memoryCache(); stores.set(name, store); }
    return store;
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: {
    open: async (name: string) => get(name).cache,
    match: async (request: RequestInfo | URL, options?: MultiCacheQueryOptions) => {
      const candidates = options?.cacheName ? [stores.get(options.cacheName)] : [...stores.values()];
      for (const store of candidates) {
        const response = await store?.cache.match(request);
        if (response) return response;
      }
      return undefined;
    },
  } });
  t.after(() => original ? Object.defineProperty(globalThis, 'caches', original) : Reflect.deleteProperty(globalThis, 'caches'));
  return get(name);
}

function memoryCache() {
  const stored = new Map<string, Response>();
  const key = (request: RequestInfo | URL) => request instanceof Request ? request.url : String(request);
  const cache = {
    keys: async () => [...stored.keys()].map(url => new Request(url)),
    match: async (request: RequestInfo | URL) => stored.get(key(request))?.clone(),
    put: async (request: RequestInfo | URL, response: Response) => { stored.set(key(request), response.clone()); },
    delete: async (request: RequestInfo | URL) => stored.delete(key(request)),
  };
  return { stored, cache };
}
