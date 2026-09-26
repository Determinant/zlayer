import { pluginFileKey, readDerivedArtifact, type PluginFileResult } from '../../../core/storage/plugin-file-cache';
import { transfer, type Remote } from 'comlink';
import { WorkerClient } from '../../../core/data/worker-client';
import { ResourceError } from '../../../core/data/errors';
import { transferFile } from '../../../core/storage/file-transfer';
import { FORECAST_CACHE_BYTES, pluginStorage } from '../storage';
import { gridKey, type DecodedGrid } from './format';
import type { NativeFrame, ForecastManifest, WindFrame } from './native-source';
import type { ForecastSelection } from './selection';
import type { GridConversionWorker } from './conversion.worker';
import { acquireForecast, interpolateWind, loadForecast } from './loading';
import { windSeed } from './wind-levels';
import type { GridBand } from './packed';
import { weatherTiming } from './performance';
import { downloadPrepared, loadWindInput, MAX_ARTIFACT_BYTES, preparedSource } from './prepared-client';
import { convertedReference, forecastRetention } from './retention';

const converted = pluginStorage.files('converted-grids', {
  maxEntries: 64, maxBytes: FORECAST_CACHE_BYTES, maxFileBytes: MAX_ARTIFACT_BYTES, maxUnusedMs: 48 * 3600000,
});
let sharedWorker: WorkerClient<GridConversionWorker> | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let busy = false;
function createWorker() {
  try { return new WorkerClient<GridConversionWorker>(new Worker(new URL('./conversion.worker.ts', import.meta.url), { type: 'module' }), 'Weather worker unavailable'); }
  catch (cause) { throw new ResourceError('worker', 'Weather worker unavailable', { cause }); }
}
export function releaseConversionWorker() {
  clearTimeout(idleTimer); idleTimer = undefined;
  if (!busy) { sharedWorker?.dispose(); sharedWorker = undefined; }
}
function inWorker<T>(signal: AbortSignal, work: (worker: WorkerClient<GridConversionWorker>) => Promise<T>): Promise<T> {
  return loadForecast(signal, async () => {
    signal.throwIfAborted();
    if (busy) throw new Error('Forecast worker admission is not serialized');
    clearTimeout(idleTimer); idleTimer = undefined;
    if (!sharedWorker || sharedWorker.retired) sharedWorker = createWorker();
    const worker = sharedWorker; busy = true;
    const cancel = () => worker.dispose(); signal.addEventListener('abort', cancel, { once: true });
    try { return await work(worker); }
    catch (error) { worker.dispose(); throw error; }
    finally {
      signal.removeEventListener('abort', cancel);
      try { if (!worker.retired) await worker.call(remote => remote.reset()); }
      finally { busy = false; idleTimer = setTimeout(releaseConversionWorker, 30_000); }
    }
  });
}
type ConvertedSelection = Exclude<ForecastSelection, { kind: 'archive' }>;
export async function hasConvertedGrid(baseUrl: string, { manifest, frame }: ConvertedSelection, signal: AbortSignal): Promise<boolean> {
  return converted.has({ ...convertedReference(baseUrl, manifest, frame), signal,
    retention: await forecastRetention(baseUrl, manifest, frame) });
}

export function retainedConvertedGrids(baseUrl: string, manifest: ForecastManifest, frames: readonly (NativeFrame | WindFrame)[], signal: AbortSignal): Promise<boolean[]> {
  return converted.retained(frames.map(frame => convertedReference(baseUrl, manifest, frame)), signal);
}

/** Native fields come from the server; selected wind altitudes are derived in the PWA. */
export async function loadConvertedGrid(baseUrl: string, selection: ConvertedSelection, signal: AbortSignal, online: boolean, onReady?: (data: DecodedGrid) => void): Promise<PluginFileResult<DecodedGrid>> {
  const { manifest, frame } = selection;
  let fresh: { bytes: ArrayBuffer; grid: DecodedGrid } | undefined;
  const reference = convertedReference(baseUrl, manifest, frame), geometry = { grid: manifest.grid, fields: manifest.fields, product: manifest.product };
  const encode = async (worker: WorkerClient<GridConversionWorker>, result: { buffer: ArrayBuffer; bands: GridBand[] },
    ready: (data: DecodedGrid) => void, signal: AbortSignal) => {
    const grid = { manifest, frame, bands: result.bands, byteLength: result.buffer.byteLength };
    ready(grid);
    // The display owns the compact bands. Encoding borrows one compact copy in
    // the worker; the much larger float conversion buffer has already been freed.
    try {
      const bytes = await worker.call<ArrayBuffer>(remote => remote.encode(result.buffer));
      if (bytes.byteLength > MAX_ARTIFACT_BYTES) return { value: grid };
      fresh = { bytes, grid }; return bytes;
    } catch { signal.throwIfAborted(); return { value: grid }; }
  };
  return converted.deriveResult({ ...reference, label: 'This forecast time / altitude', signal, cacheOnly: !online,
    retention: await forecastRetention(baseUrl, manifest, frame),
    run: selection.kind === 'native' ? acquireForecast : interpolateWind,
    ...(onReady ? { onReady } : {}),
    legacy: [{ cache: converted.cacheName, key: pluginFileKey({ url: reference.url, identity: gridKey(manifest, frame) }),
      async convert(response, signal, ready) {
        const bytes = await readDerivedArtifact(response, MAX_ARTIFACT_BYTES, signal);
        return inWorker(signal, async worker => encode(worker, await worker.call(remote => remote.migrate(transfer(bytes, [bytes]), geometry)), ready, signal));
      } }],
    async create(signal, ready) {
      if (selection.kind === 'native') {
        const bytes = await downloadPrepared(await preparedSource(baseUrl, selection.manifest, selection.frame), signal);
        const result = await inWorker(signal, worker => worker.call<{ buffer: ArrayBuffer; bands: GridBand[] }>(remote => remote.decodePacked(bytes, geometry)));
        const grid = { manifest, frame, bands: result.bands, byteLength: result.buffer.byteLength };
        fresh = { bytes, grid }; ready(grid); return bytes;
      }
      const wind = selection;
      // One admitted wind job owns its interpolation state. Scalar decoding can
      // proceed during its network/storage waits; CPU calls still share admission.
      const worker = createWorker(), cancel = () => worker.dispose();
      const step = <T>(request: (remote: Remote<GridConversionWorker>) => Promise<T>) => loadForecast(signal, () => worker.call(request));
      signal.addEventListener('abort', cancel, { once: true });
      try {
        const terrain = wind.kind === 'native-wind'
          ? await loadWindInput(baseUrl, wind.manifest, wind.frame.levels[0]!, true, signal, online,
            bytes => step<Float32Array<ArrayBuffer>>(remote => remote.decodeTerrain(bytes, manifest.grid))) : undefined;
        await step(remote => remote.startWind(geometry, wind.frame.windAltitude, terrain ? transfer(terrain, [terrain.buffer]) : undefined));
        let low = windSeed(wind.frame.levels, wind.frame.windAltitude), high = low, index = low;
        for (;;) {
          signal.throwIfAborted();
          let needed: { below: boolean; above: boolean };
          if (wind.kind === 'native-wind') {
            const level = wind.frame.levels[index]!;
            const packed = await loadWindInput(baseUrl, wind.manifest, level, false, signal, online,
              bytes => step<{ buffer: ArrayBuffer; bands: GridBand[] }>(remote => remote.decodePacked(bytes, geometry)));
            needed = await step(remote => remote.windLevel(level.pressureHpa!, transfer(packed.bands, [packed.buffer])));
          } else {
            const level = wind.frame.levels[index]!;
            // Compatibility for archived, already converted pressure-level feeds.
            const raw = await transferFile({ url: new URL(level.path, baseUrl).href, byteLength: level.bytes,
              maximumBytes: MAX_ARTIFACT_BYTES, label: 'Archived wind level', signal, timeoutMs: 45_000, retries: 1 }, async ({ blob }) => blob.arrayBuffer());
            needed = await step(remote => remote.windSource(level.pressureHpa!, transfer(raw, [raw]),
              { bytes: level.bytes, decodedBytes: level.decodedBytes, sha256: level.sha256 }));
          }
          if (needed.below && low > 0) index = --low;
          else if (needed.above && high < wind.frame.levels.length - 1) index = ++high;
          else break;
        }
        return await loadForecast(signal, async () => encode(worker, await worker.call(remote => remote.finishWind()), ready, signal));
      } finally { signal.removeEventListener('abort', cancel); worker.dispose(); }
    },
    async validate(bytes, signal) {
      if (fresh?.bytes === bytes) return fresh.grid;
      // Keep core's compressed input intact for its receipt/publication; return only
      // the decoded buffer by transfer, with no copy of the full numeric bundle.
      const done = weatherTiming('cache-decode');
      try {
        const result = await inWorker(signal, worker => worker.call<{ buffer: ArrayBuffer; bands: GridBand[] }>(remote => remote.decodePacked(bytes, geometry)));
        return { manifest, frame, bands: result.bands, byteLength: result.buffer.byteLength };
      } finally { done(); }
    },
  }).then(result => ({ ...result, value: { ...result.value, manifest, frame } }));
}
