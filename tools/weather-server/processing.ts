import type { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { normalizeAdvisories, isSourceCollection } from '../../src/layers/weather-awc/source';
import { gridKey, forecastPath } from '../../src/layers/weather-awc/grids/identity';
import { terrainKey, terrainPath } from '../../src/layers/weather-awc/grids/model-terrain';
import { createTaskLimiter } from '../../src/core/data/task-limiter';
import type { AwcAdvisoryProduct, AwcGridProduct } from '@zlayer/contracts';
import type { NativeFrame, NativeManifest, SourceRecord } from '../../src/layers/weather-awc/grids/native-source';
import { discover } from './discovery';
import type { WeatherCache } from './cache';
import { HttpError, MiB, advisoryResource, modelResource, resourceFor, type Resource } from './routes';
import { digest, type Payload } from './upstream';
import { workerError, type ConversionJob, type ConversionRequest, type ConversionResponse } from './worker-protocol';
import { createWeatherWorker, workerModule } from './worker-job';
import { sourceBlocks, sourceRecordKey } from './source-records';
import { selectNativeFrame } from '../../src/layers/weather-awc/grids/selection';

export function forecastResource(manifest: NativeManifest, frame: NativeFrame): Resource {
  const identity = digest(Buffer.from(gridKey(manifest, frame)));
  return resourceFor(`/api/weather/grids/${forecastPath(manifest, frame, identity)}`);
}
export function terrainResource(manifest: NativeManifest, frame: NativeFrame): Resource {
  return resourceFor(`/api/weather/grids/${terrainPath(manifest, digest(Buffer.from(terrainKey(manifest, frame))))}`);
}

/** Background preparation owns these workers. HTTP readers never queue conversions. */
export function createProcessing(cache: WeatherCache, shutdown: AbortSignal, now = Date.now) {
  type Slot = { worker?: Worker | undefined; idle?: ReturnType<typeof setTimeout> | undefined;
    stopped?: Promise<number> | undefined; busy: boolean };
  const slots: Slot[] = Array.from({ length: Math.min(4, availableParallelism()) }, () => ({ busy: false }));
  const prepare = createTaskLimiter(slots.length);
  const stop = (slot: Slot) => {
    clearTimeout(slot.idle);
    if (slot.worker) { slot.stopped = slot.worker.terminate(); slot.worker = undefined; }
    return slot.stopped;
  };
  shutdown.addEventListener('abort', () => { for (const slot of slots) void stop(slot); }, { once: true });
  // Composite responses inherit their oldest dependency's check time. Refresh
  // aging inputs before assembling them, leaving time to finish within the TTL.
  const readMetadata = (resource: Resource, signal: AbortSignal) => cache.get(resource, resource.ttl / 2, signal);
  const read = async (path: string, signal: AbortSignal) => { signal.throwIfAborted(); return readMetadata(modelResource(path), signal); };
  type ReadRecord = (record: SourceRecord, signal: AbortSignal) => Promise<Buffer>;
  const readers = new WeakMap<NativeManifest, ReadRecord>();
  const reader = (manifest: NativeManifest): ReadRecord => {
    const existing = readers.get(manifest);
    if (existing) return existing;
    const plan = sourceBlocks(manifest.frames.flatMap(frame => Object.values(frame.records)));
    const readRecord: ReadRecord = async (record, signal) => {
      const block = plan.get(sourceRecordKey(record));
      const resource = block?.resource ?? modelResource(record.path, `bytes=${record.start}-${record.end ?? ''}`, record.indexHash);
      const payload = await cache.get(resource, undefined, signal);
      const start = record.start - (block?.start ?? record.start);
      const body = payload.body.subarray(start, record.end === undefined ? undefined : start + record.end - record.start + 1);
      if (body.length < 20 || body.toString('ascii', 0, 4) !== 'GRIB' || body.readBigUInt64BE(8) !== BigInt(body.length) ||
        body.toString('ascii', body.length - 4) !== '7777') throw new Error('Source record does not match its index range');
      return body;
    };
    readers.set(manifest, readRecord);
    return readRecord;
  };
  async function convert(job: ConversionJob, signal: AbortSignal, readRecord: ReadRecord): Promise<ArrayBuffer> {
    return prepare(signal, async () => {
      signal.throwIfAborted();
      const slot = slots.find(slot => !slot.busy)!;
      slot.busy = true;
      const timeout = new AbortController(), work = AbortSignal.any([signal, timeout.signal]);
      const timer = setTimeout(() => timeout.abort(new HttpError(503, 'Forecast preparation timed out', 5)), 150_000).unref();
      const sources = new Map<string, Buffer>();
      try {
        // Terrain is retained by each worker and read only when its run changes.
        const records = job.terrainOnly ? [job.frame.records.terrain]
          : Object.entries(job.frame.records).filter(([field]) => field !== 'terrain').map(([, record]) => record);
        await Promise.all(records.map(async record => {
          if (record) {
            const payload = await readRecord(record, work);
            work.throwIfAborted(); sources.set(sourceRecordKey(record), payload);
          }
        }));
        work.throwIfAborted(); clearTimeout(slot.idle);
        if (!slot.worker) await slot.stopped;
        work.throwIfAborted();
        slot.worker ??= createWeatherWorker(workerModule(import.meta.url, 'worker'));
        const current = slot.worker;
        return await new Promise<ArrayBuffer>((resolve, reject) => {
          let finished = false;
          const cleanup = () => { finished = true; work.removeEventListener('abort', aborted);
            current.off('message', message); current.off('error', fail); current.off('messageerror', fail); current.off('exit', exited); };
          const fail = (error: Error) => { if (finished) return; cleanup(); void stop(slot); reject(error); };
          const aborted = () => fail(work.reason);
          const exited = () => fail(new Error('Forecast worker stopped'));
          const message = (value: ConversionResponse) => {
            if (value.type === 'read') {
              const key = sourceRecordKey(value.record), prepared = sources.get(key);
              sources.delete(key);
              void (prepared ? Promise.resolve(prepared) : readRecord(value.record, work)).then(payload => {
                if (finished) return;
                const body = Uint8Array.from(payload).buffer;
                current.postMessage({ type: 'read', id: value.id, body } satisfies ConversionRequest, [body]);
              }, error => fail(error instanceof Error ? error : new Error(String(error))));
            } else if (value.type === 'error') fail(workerError(value.error));
            else { cleanup(); resolve(value.value); }
          };
          current.on('message', message); current.once('error', fail); current.once('messageerror', fail); current.once('exit', exited);
          work.addEventListener('abort', aborted, { once: true });
          if (work.aborted) { aborted(); return; }
          current.postMessage({ type: 'convert', job } satisfies ConversionRequest);
        });
      } finally {
        clearTimeout(timer); timeout.abort(); sources.clear(); slot.busy = false;
        slot.idle = setTimeout(() => { void stop(slot); }, 30_000).unref();
      }
    });
  }
  const json = (value: unknown, checkedAt: number): Payload => {
    const body = Buffer.from(JSON.stringify(value));
    return { body, checkedAt, sha256: digest(body), status: 200, headers: { 'content-type': 'application/json' } };
  };
  async function load(resource: Resource): Promise<Payload> {
    const advisory = /^\/api\/weather\/advisories\/(gairmet|sigmet|cwa)\.json$/.exec(new URL(resource.url).pathname);
    if (!advisory) throw new HttpError(404, 'Forecasts are published by the background updater');
    const product = advisory[1] as AwcAdvisoryProduct, endpoint = product === 'sigmet' ? 'airsigmet' : product;
    const input = await readMetadata(advisoryResource(product), shutdown);
    const parsed: unknown = JSON.parse(input.body.toString()), collections = product === 'gairmet' && Array.isArray(parsed) ? parsed : [parsed];
    if (!collections.every(isSourceCollection)) throw new Error('Invalid advisory collection');
    return json(normalizeAdvisories(product, collections, input.checkedAt, `https://aviationweather.gov/api/data/${endpoint}`), input.checkedAt);
  }
  async function catalog(product: AwcGridProduct): Promise<Payload> {
    const manifest = await discover(read, product, shutdown, now());
    return json(manifest, manifest.checkedAt);
  }
  async function forecast(manifest: NativeManifest, frame: NativeFrame, terrainOnly = false): Promise<Payload> {
    // The worker receives one validated selection, not the full catalog.
    const selected = selectNativeFrame({ ...manifest, frames: [] }, frame);
    const body = Buffer.from(await convert({ ...selected, terrainOnly }, shutdown, reader(manifest)));
    if (body.length > 16 * MiB) throw new Error('Prepared forecast exceeds its byte limit');
    return { body, sha256: digest(body), checkedAt: manifest.checkedAt, status: 200,
      headers: { 'content-type': 'application/octet-stream', 'x-weather-artifact': digest(Buffer.from(terrainOnly ? terrainKey(manifest, frame) : gridKey(manifest, frame))) } };
  }
  return { load, catalog, forecast, concurrency: slots.length, close: async () => { await Promise.all(slots.map(stop)); } };
}
