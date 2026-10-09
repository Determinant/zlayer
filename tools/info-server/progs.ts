import { isSurfaceCatalog, SURFACE_PRODUCTS, SURFACE_PROCESSING, type SurfaceProduct, type SurfaceCatalog, type SurfaceFile } from '@zlayer/contracts';
import { SURFACE_CATALOG } from '../../src/layers/weather-awc/progs/source';
import type { WeatherCache } from './cache';
import { HttpError, resourceFor } from './routes';
import { progsSourceResource, readProgsCatalog } from './progs-source';
import { digest } from './upstream';
import { workerJob, workerModule } from './worker-job';
import type { SurfaceJob, SurfaceResult } from './progs-worker';
import { WorkerInputError } from './worker-protocol';

export const PUBLISHED_PROGS = `wpc-surface-v3-${SURFACE_PROCESSING}`;
export const progsResource = (product: SurfaceProduct) => resourceFor(`/api/weather/progs/${product}.json`);
const chartResource = (file: Pick<SurfaceFile, 'path'>) => resourceFor(`/api/weather/progs/${file.path}`);
type State = { catalog?: SurfaceCatalog; task?: Promise<void> | undefined; nextCheck: number; error?: string | undefined; building: Set<string> };

/** Small atomic catalogs reference immutable charts. CPU preparation runs only
 * for changed sources, in workers; HTTP serves previously published bytes. */
export function createProgsWarming(cache: WeatherCache, signal: AbortSignal,
  options: { now?: () => number; log?: (message: string) => void } = {}) {
  const now = options.now ?? Date.now;
  const states = new Map(SURFACE_PRODUCTS.map(product => [product, { nextCheck: 0, building: new Set<string>() } as State]));
  const retained = new Map<string, number>();
  const protect = () => {
    for (const [key, until] of retained) if (until <= now()) retained.delete(key);
    cache.retain([...SURFACE_PRODUCTS.map(product => progsResource(product).key), ...retained.keys(),
      ...[...states.values()].flatMap(state => [...(state.catalog?.frames.map(f => chartResource(f).key) ?? []), ...state.building])], 'progs');
  };
  protect();
  async function update(product: SurfaceProduct, state: State) {
    try {
      const { payload: catalog, charts } = await readProgsCatalog(cache, signal, product, state.catalog?.frames ?? []);
      const frames: SurfaceFile[] = [], jobs: SurfaceJob[] = [];
      for (const chart of charts) {
        const input = await cache.get(progsSourceResource(chart.source, 512 * 1024), 150_000, signal);
        const previous = state.catalog?.frames.find(frame => frame.source === chart.source && frame.sourceHash === input.sha256 &&
          frame.referenceTime === chart.referenceTime && frame.validTime === chart.validTime);
        if (previous && await cache.check(chartResource(previous))) frames.push({ ...previous, checkedAt: input.checkedAt });
        else jobs.push({ text: input.body.toString('utf8'), chart, checkedAt: input.checkedAt, sourceHash: input.sha256 });
      }
      if (jobs.length) {
        const results = await workerJob<SurfaceResult[]>(workerModule(import.meta.url, 'progs-worker'),
          { product, jobs }, signal).catch(async cause => {
          if (cause instanceof WorkerInputError) for (const index of cause.inputIndices) {
            const job = jobs[index]!;
            await cache.reject(progsSourceResource(job.chart.source, 512 * 1024),
              { checkedAt: job.checkedAt, sha256: job.sourceHash }, new HttpError(502, cause.message, 30));
          }
          throw cause;
        });
        for (const [index, result] of results.entries()) {
          signal.throwIfAborted();
          const job = jobs[index]!, body = Buffer.from(result.body), sha256 = digest(body), path = `${product}/${sha256}.json`;
          const file: SurfaceFile = { validTime: job.chart.validTime, referenceTime: job.chart.referenceTime, source: job.chart.source,
            sourceHash: job.sourceHash, checkedAt: job.checkedAt, path, sha256, byteLength: body.length,
            positions: result.positions, documentLength: result.documentLength };
          const resource = chartResource(file);
          state.building.add(resource.key); protect();
          await cache.put(resource, { body, sha256, status: 200, checkedAt: job.checkedAt,
            headers: { 'content-type': 'application/json', 'x-weather-artifact': PUBLISHED_PROGS } });
          frames.push(file);
        }
      }
      frames.sort((a, b) => a.validTime - b.validTime);
      const next: SurfaceCatalog = { schemaVersion: 3, product,
        checkedAt: Math.min(catalog.checkedAt, ...frames.map(f => f.checkedAt)), source: SURFACE_CATALOG,
        sourceHash: digest(Buffer.from(JSON.stringify([PUBLISHED_PROGS, frames.map(f => f.sha256)]))),
        sourceCatalog: catalog.body.toString('utf8'), frames };
      if (!isSurfaceCatalog(next)) throw new Error('Invalid prepared surface catalog');
      const previous = state.catalog?.frames;
      const body = Buffer.from(JSON.stringify(next));
      await cache.put(progsResource(product), { body, status: 200, checkedAt: next.checkedAt, sha256: digest(body),
        headers: { 'content-type': 'application/json', 'x-weather-catalog': PUBLISHED_PROGS } });
      for (const file of previous ?? []) retained.set(chartResource(file).key, now() + 10 * 60_000);
      if (state.error) options.log?.(`Surface update recovered (${product})`);
      state.catalog = next; state.error = undefined; state.nextCheck = now() + 5 * 60_000;
    } catch (error) {
      if (signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      if (message !== state.error) options.log?.(`Surface update failed (${product}): ${message}`);
      state.error = message;
      state.nextCheck = now() + 30_000;
    } finally { state.building.clear(); protect(); }
  }
  return {
    async restore() {
      for (const product of SURFACE_PRODUCTS) {
        const resource = progsResource(product), payload = await cache.read(resource);
        if (!payload) continue;
        let value: unknown;
        try { value = JSON.parse(payload.body.toString()); } catch { /* Invalid saved data. */ }
        if (payload.headers['x-weather-catalog'] === PUBLISHED_PROGS && isSurfaceCatalog(value) &&
          value.product === product && value.checkedAt === payload.checkedAt && await cache.checkAll(value.frames.map(chartResource))) {
          const state = states.get(product)!;
          state.catalog = value; state.nextCheck = value.checkedAt + 5 * 60_000;
          protect();
        } else await cache.discard(resource);
      }
    },
    refresh() {
      for (const [product, state] of states) if (!signal.aborted && !state.task && now() >= state.nextCheck) {
        state.task = update(product, state).finally(() => { state.task = undefined; });
      }
    },
    get status() {
      return Object.fromEntries([...states].map(([product, state]) => [product, {
        ready: !!state.catalog && cache.has(progsResource(product)) && state.catalog.frames.every(f => cache.has(chartResource(f))), preparing: !!state.task,
        validTimes: state.catalog?.frames.map(f => f.validTime), checkedAt: state.catalog?.checkedAt, nextAttemptAt: state.nextCheck,
        ...(state.error ? { error: state.error } : {}),
      }]));
    },
    async close() { await Promise.allSettled([...states.values()].map(state => state.task)); },
  };
}
