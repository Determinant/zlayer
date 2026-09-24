import type { AwcGridProduct } from '@zlayer/contracts';
import { isNativeManifest, type NativeManifest } from '../../src/layers/weather-awc/grids/native-source';
import type { WeatherCache } from './cache';
import { forecastResource, terrainResource, type createProcessing } from './processing';
import { HttpError, InvalidForecastSourceError, resourceFor, type Resource } from './routes';
import type { Payload } from './upstream';

const PRODUCTS: AwcGridProduct[] = ['clouds', 'icing', 'winds'];
export const PUBLISHED_CATALOG = 'complete-native-v1';
const catalogResource = (product: AwcGridProduct) => resourceFor(`/api/weather/grids/${product}.json`);
function generation(manifest: NativeManifest, payload: Payload) {
  const files = manifest.frames.map(frame => ({ resource: forecastResource(manifest, frame), frame, terrain: false }));
  if (manifest.product === 'winds') files.unshift({ resource: terrainResource(manifest, manifest.frames[0]!), frame: manifest.frames[0]!, terrain: true });
  return { manifest, payload, files };
}
type Generation = ReturnType<typeof generation>;
type State = { current?: Generation | undefined; candidate?: Generation | undefined;
  previous?: Resource[] | undefined; task?: Promise<void> | undefined;
  nextCheck: number; completed: number; error?: string | undefined };

/** Prepare in the background, then atomically publish the complete catalog.
 * HTTP readers never discover sources or prepare missing forecast files. */
export function createForecastWarming(cache: WeatherCache, processing: Pick<ReturnType<typeof createProcessing>, 'catalog' | 'forecast' | 'concurrency'>,
  signal: AbortSignal, options: { now?: () => number; log?: (message: string) => void } = {}) {
  const now = options.now ?? Date.now;
  const states = new Map(PRODUCTS.map(product => [product, { nextCheck: 0, completed: 0 } as State]));
  function retain() {
    cache.retain(PRODUCTS.flatMap(product => {
      const state = states.get(product)!;
      return [catalogResource(product).key, ...(state.current?.files ?? []).map(file => file.resource.key),
        ...(state.candidate?.files ?? []).map(file => file.resource.key), ...(state.previous ?? []).map(resource => resource.key)];
    }));
  }
  async function update(product: AwcGridProduct, state: State) {
    // The preceding release has had at least one browser refresh interval to drain.
    state.previous = undefined; retain();
    try {
      if (!state.candidate) {
        const payload = await processing.catalog(product);
        signal.throwIfAborted();
        const manifest: unknown = JSON.parse(payload.body.toString());
        if (!isNativeManifest(manifest) || manifest.product !== product) throw new Error('Invalid discovered forecast catalog');
        state.candidate = generation(manifest, payload); retain();
      }
      const candidate = state.candidate;
      state.completed = 0;
      for (let start = 0; start < candidate.files.length; start += processing.concurrency) {
        // Keep the shared workers useful when only one product needs updating.
        // Settle the whole batch before retrying or releasing its retained files.
        const batch = await Promise.allSettled(candidate.files.slice(start, start + processing.concurrency).map(async file => {
          signal.throwIfAborted();
          if (!await cache.check(file.resource)) {
            const payload = await processing.forecast(candidate.manifest, file.frame, file.terrain);
            signal.throwIfAborted();
            await cache.put(file.resource, payload);
          }
          state.completed++;
        }));
        for (const result of batch) if (result.status === 'rejected') throw result.reason;
      }
      if (!candidate.files.every(file => cache.has(file.resource))) throw new Error('Forecast generation is not fully saved');
      await cache.put(catalogResource(product), { ...candidate.payload,
        headers: { ...candidate.payload.headers, 'x-weather-catalog': PUBLISHED_CATALOG } });
      state.previous = state.current?.files.map(file => file.resource);
      state.current = candidate; state.candidate = undefined; state.error = undefined;
      // Keep the preceding files through the PWA's five-minute poll plus a request.
      state.nextCheck = now() + 6 * 60_000;
      retain();
      options.log?.(`Published ${product} ${new Date(candidate.manifest.runTime).toISOString()}: ${candidate.files.length} saved files`);
    } catch (error) {
      if (signal.aborted) return;
      state.error = error instanceof Error ? error.message : String(error);
      // Retry transport/backoff failures against the same candidate. A removed,
      // changed or invalid source needs discovery again; otherwise one bad run
      // could pin the updater forever after newer data becomes available.
      if (!(error instanceof HttpError) || error instanceof InvalidForecastSourceError || [403, 404, 409, 416].includes(error.status)) {
        state.candidate = undefined; retain();
      }
      state.nextCheck = now() + 30_000;
      options.log?.(`Forecast update failed (${product}): ${state.error}`);
    }
  }
  return {
    async restore() {
      for (const product of PRODUCTS) {
        const payload = await cache.read(catalogResource(product));
        if (!payload || payload.headers['x-weather-catalog'] !== PUBLISHED_CATALOG) continue;
        let manifest: unknown;
        try { manifest = JSON.parse(payload.body.toString()); } catch { /* Invalid saved catalog. */ }
        if (!isNativeManifest(manifest) || manifest.product !== product) { await cache.discard(catalogResource(product)); continue; }
        const saved = generation(manifest, payload);
        let complete = true;
        for (const file of saved.files) if (!await cache.check(file.resource)) { complete = false; break; }
        if (complete) states.get(product)!.current = saved;
        else await cache.discard(catalogResource(product));
      }
      retain();
    },
    refresh() {
      for (const [product, state] of states) if (!signal.aborted && !state.task && now() >= state.nextCheck) {
        state.task = update(product, state).finally(() => { state.task = undefined; });
      }
    },
    get status() {
      return Object.fromEntries([...states].map(([product, state]) => [product, {
        ready: !!state.current && cache.has(catalogResource(product)) && state.current.files.every(file => cache.has(file.resource)),
        runTime: state.current?.manifest.runTime,
        preparing: !!state.task, completed: state.completed, total: state.candidate?.files.length,
        ...(state.error ? { error: state.error } : {}),
      }]));
    },
    async close() { await Promise.allSettled([...states.values()].map(state => state.task)); },
  };
}
