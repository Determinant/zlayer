import { isAwcGridManifest, isRecord, type AwcGridProduct } from '@zlayer/contracts';
import { requestJson } from '../../../core/data/fetch-json';
import { FORECAST_CACHE_BYTES, pluginStorage } from '../storage';
import { decodeGrid, gridKey, type DecodedGrid } from './format';
import { discoverGrids, HRRR_DOWNLOAD_ROOT, isNativeManifest, nativeManifest, type ForecastManifest, type ForecastFrame } from './native-source';
import { hasConvertedGrid, loadConvertedGrid, releaseConversionWorker, retainedConvertedGrids } from './conversion-client';
import { loadForecast } from './loading';
import { weatherTiming } from './performance';

const frames = pluginStorage.files('grids', {
  maxEntries: 64, maxBytes: FORECAST_CACHE_BYTES, maxFileBytes: 16 * 1024 * 1024,
  maxUnusedMs: 48 * 3600000, legacyCache: 'zlayers-awc-grids-v1',
});
export type GridProductState = { manifest?: ForecastManifest; checkedAt?: number; error?: string; storageError?: string; loading: boolean };

export class GridClient {
  private readonly memory = new Map<string, DecodedGrid>();
  private readonly targets = new Map<AwcGridProduct, { key: string; bytes: number }[]>();
  // Receipt objects distinguish a newer save from the same boolean value read
  // before an asynchronous inventory check. Metadata-only copies share a token.
  private readonly receipts = new WeakMap<DecodedGrid, { saved: boolean }>();
  private retained = new Set<string>();
  private readonly listeners = new Set<() => void>();
  subscribeMemory(listener: () => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }

  /** Share a 96 MiB decoded budget across scalar and wind streams. Selected
   * bundles rank before their next/previous neighbors; distant preparation never
   * pushes a useful nearby frame out of memory. */
  neighborhood(product: AwcGridProduct, manifest?: ForecastManifest, frames: readonly ForecastFrame[] = []): void {
    this.targets.set(product, manifest ? frames.map(frame => ({ key: gridKey(manifest, frame),
      bytes: 16 + manifest.grid.width * manifest.grid.height * manifest.fields.length * 4 })) : []);
    const candidates = [...this.targets.values()].flatMap(items => items.map((item, rank) => ({ ...item,
      bytes: this.memory.get(item.key)?.byteLength ?? item.bytes, rank }))).sort((a, b) => a.rank - b.rank);
    let bytes = 0;
    const retained = new Set(candidates.filter(item => {
      if (bytes + item.bytes > 96 * 1024 * 1024) return false;
      bytes += item.bytes; return true;
    }).map(item => item.key));
    const changed = retained.size !== this.retained.size || [...retained].some(key => !this.retained.has(key));
    this.retained = retained;
    for (const key of this.memory.keys()) if (!this.retained.has(key)) this.memory.delete(key);
    if (![...this.targets.values()].some(items => items.length)) releaseConversionWorker();
    if (changed) queueMicrotask(() => { for (const listener of this.listeners) listener(); });
  }
  wants(manifest: ForecastManifest, frame: ForecastFrame): boolean { return this.retained.has(gridKey(manifest, frame)); }
  peek(manifest: ForecastManifest, frame: ForecastFrame): DecodedGrid | undefined {
    const key = gridKey(manifest, frame), previous = this.memory.get(key);
    if (!previous || previous.manifest === manifest) return previous;
    const value = { ...previous, manifest, frame };
    const receipt = this.receipts.get(previous);
    if (receipt) this.receipts.set(value, receipt);
    this.memory.set(key, value);
    return value;
  }
  saved(data: DecodedGrid): boolean { return this.receipts.get(data)?.saved === true; }
  subscribeFiles(listener: () => void): () => void { return pluginStorage.subscribeFiles(listener); }
  /** Reconcile old save receipts without decoding, touching LRU, or downloading. */
  async checkSaved(manifest: ForecastManifest, selected: readonly ForecastFrame[], signal: AbortSignal): Promise<boolean[]> {
    const before = selected.map(frame => {
      const data = this.peek(manifest, frame);
      return data && this.receipts.get(data);
    });
    const converted = selected.filter(frame => 'levels' in frame || 'records' in frame);
    const archived = selected.filter(frame => 'path' in frame);
    const [native, legacy] = await Promise.all([
      retainedConvertedGrids(this.baseUrl, manifest, converted, signal),
      frames.retained(archived.map(frame => ({ url: new URL(frame.path, this.baseUrl).href,
        identity: `grid-v1/${gridKey(manifest, frame)}`, byteLength: frame.bytes })), signal),
    ]);
    signal.throwIfAborted();
    const retained = new Map<ForecastFrame, boolean>([...converted.map((frame, i) => [frame, native[i]!] as const),
      ...archived.map((frame, i) => [frame, legacy[i]!] as const)]);
    return selected.map((frame, index) => {
      const saved = retained.get(frame)!, memory = this.peek(manifest, frame);
      if (memory) {
        const current = this.receipts.get(memory);
        if (current !== before[index]) return current?.saved === true;
        this.receipts.set(memory, { saved });
      }
      return saved;
    });
  }
  async prepare(manifest: ForecastManifest, frame: ForecastFrame, signal: AbortSignal, online: boolean): Promise<boolean> {
    signal.throwIfAborted();
    const memory = this.peek(manifest, frame);
    // Preparation may retry an optional save without evicting the usable display.
    if (memory) return this.saved(memory) || online && this.saved(await this.acquire(manifest, frame, signal, online));
    // Nearby frames are decoded ahead of time. Distant saved files need only a
    // receipt check; their bytes are authenticated when selected/warmed.
    if (!this.wants(manifest, frame)) {
      const saved = 'levels' in frame || nativeManifest(manifest) && 'records' in frame
        ? await hasConvertedGrid(this.baseUrl, manifest, frame, signal)
        : !nativeManifest(manifest) && !('records' in frame) && await frames.has({
          url: new URL(frame.path, this.baseUrl).href, identity: `grid-v1/${gridKey(manifest, frame)}`, byteLength: frame.bytes, signal });
      if (saved) return true;
    }
    return this.saved(await this.load(manifest, frame, signal, online));
  }
  constructor(readonly baseUrl: string, readonly native = false) {}
  restore(product: AwcGridProduct): GridProductState {
    try {
      const saved: unknown = JSON.parse(pluginStorage.slot(`grid-${product}`).read() ?? 'null');
      const valid: (value: unknown) => value is ForecastManifest = this.native ? isNativeManifest : isAwcGridManifest;
      if (isRecord(saved) && (saved.endpoint === this.baseUrl || this.native && ['/weather/awc/grids/', '/weather/noaa/'].some(path => saved.endpoint === new URL(path, this.baseUrl).href)) && (!this.native || saved.hrrrSource === HRRR_DOWNLOAD_ROOT) && valid(saved.manifest) &&
        saved.manifest.product === product && saved.manifest.publishedAt <= Date.now() + 60_000) return { manifest: saved.manifest, loading: false };
    } catch { /* Optional cache. */ }
    return { loading: false };
  }
  remember(manifest: ForecastManifest): boolean {
    try {
      pluginStorage.slot(`grid-${manifest.product}`).write(JSON.stringify({ endpoint: this.baseUrl,
        ...(this.native ? { hrrrSource: HRRR_DOWNLOAD_ROOT } : {}), manifest }));
      return true;
    } catch { return false; }
  }
  /** Read live metadata; the controller saves it after a matching file receipt. */
  async refresh(product: AwcGridProduct, signal: AbortSignal): Promise<ForecastManifest> {
    const manifest = this.native ? await discoverGrids(this.baseUrl, product, signal)
      : await requestJson(new URL(`${product}.json`, this.baseUrl).href, isAwcGridManifest, 'Weather forecast', { signal });
    if (manifest.product !== product || manifest.publishedAt > Date.now() + 60_000) throw new Error('Forecast product or source clock mismatch');
    signal.throwIfAborted();
    return manifest;
  }
  async load(manifest: ForecastManifest, frame: ForecastFrame, signal: AbortSignal, online: boolean, onReady?: (data: DecodedGrid) => void): Promise<DecodedGrid> {
    signal.throwIfAborted();
    return this.peek(manifest, frame) ?? this.acquire(manifest, frame, signal, online, onReady);
  }
  private async acquire(manifest: ForecastManifest, frame: ForecastFrame, signal: AbortSignal, online: boolean, onReady?: (data: DecodedGrid) => void): Promise<DecodedGrid> {
    const done = weatherTiming('forecast-ready');
    let savedTiming: (() => void) | undefined;
    let live: DecodedGrid | undefined;
    const ready = (value: DecodedGrid) => {
      if (signal.aborted) return;
      live ??= { ...value, manifest, frame, endpoint: this.baseUrl }; done();
      savedTiming ??= weatherTiming('save-after-ready'); onReady?.(live);
    };
    const result = await (async () => {
      if ('levels' in frame || nativeManifest(manifest) && 'records' in frame) return loadConvertedGrid(this.baseUrl, manifest, frame, signal, online, ready);
      if (nativeManifest(manifest) || 'records' in frame) throw new Error('Mismatched forecast source');
      const url = new URL(frame.path, this.baseUrl).href;
      return frames.loadResult({ url, identity: `grid-v1/${gridKey(manifest, frame)}`, byteLength: frame.bytes, run: loadForecast,
        label: 'This forecast time / altitude', signal, cacheOnly: !online, retries: 1,
        onReady: ready,
        validate: (bytes, signal) => decodeGrid(bytes, manifest, frame, signal),
      });
    })().finally(() => savedTiming?.());
    signal.throwIfAborted();
    // The immutable identity already validates these values. Preserve the
    // displayed object when only its persistence receipt needed recovery.
    const data = this.peek(manifest, frame) ?? live ?? result.value;
    this.receipts.set(data, { saved: result.saved });
    if (this.wants(manifest, frame)) this.memory.set(gridKey(manifest, frame), data);
    return data;
  }
}
