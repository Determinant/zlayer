import { decodeTerrarium } from './contours';
import { createPixelContext } from '../../core/graphics/pixel-context';
import type { Tile } from './geometry';
import { TerrainWorkLimit } from './work-limit';
import { terrainArchiveUrl } from '@zlayer/contracts';
import { readGeographicElevation } from './geographic';
import { readPackagedElevation, type TerrainPackage } from './packages';
import { fetchElevation } from './fetch';
import { withAbort } from '../../core/data/abort';

export const DEFAULT_ELEVATION_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const TERRAIN_ATTRIBUTION = '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">Terrain: Mapzen / USGS and contributors</a>';
type PendingTile = { controller: AbortController; promise: Promise<Float32Array>; readers: number };

/** Four active DEM reads and at most 32 MiB of decoded grids per worker. */
export class ElevationTiles {
  readonly #cache = new Map<string, Float32Array>();
  readonly #downloads = new TerrainWorkLimit(4);
  readonly #pending = new Map<string, PendingTile>();

  #cached(url: string): Float32Array | undefined {
    const values = this.#cache.get(url);
    if (values) { this.#cache.delete(url); this.#cache.set(url, values); }
    return values;
  }

  async read(tile: Tile, template: string, signal: AbortSignal, source?: TerrainPackage | readonly TerrainPackage[], surface = false): Promise<Float32Array> {
    const sources: readonly TerrainPackage[] = source ? ('shard' in source ? [source] : source) : [];
    const interpolate = surface && !!sources[0]?.grid;
    const url = sources.length ? `${JSON.stringify(sources.map(s => terrainArchiveUrl(s.root, s.shard)))}#${tile.z}/${tile.x}/${tile.y}/${interpolate}`
      : template.replace('{z}', String(tile.z)).replace('{x}', String(tile.x)).replace('{y}', String(tile.y));
    signal.throwIfAborted();
    const cached = this.#cached(url);
    if (cached) return cached;
    let job = this.#pending.get(url);
    if (!job) {
      const controller = new AbortController();
      const promise = this.#downloads.run(controller.signal, async () => {
        let cacheable = true;
        const values = sources[0]?.grid ? await readGeographicElevation(tile, sources, controller.signal, () => { cacheable = false; }, interpolate)
          : sources[0] ? await readPackagedElevation(tile, sources[0], controller.signal) : await this.#decode(url, controller.signal);
        controller.signal.throwIfAborted();
        if (cacheable) this.#cache.set(url, values);
        while (this.#cache.size > 128) this.#cache.delete(this.#cache.keys().next().value!);
        return values;
      }).finally(() => { if (this.#pending.get(url) === job) this.#pending.delete(url); });
      job = { controller, promise, readers: 0 };
      this.#pending.set(url, job);
    }
    job.readers++;
    try { return await withAbort(job.promise, signal); }
    finally {
      // A route render and vector recovery can need the same DEM concurrently.
      // Cancel shared work only when its last consumer leaves, including in queue.
      if (--job.readers === 0 && this.#pending.get(url) === job) {
        this.#pending.delete(url);
        job.controller.abort();
      }
    }
  }

  async #decode(url: string, signal: AbortSignal): Promise<Float32Array> {
    const blob = await fetchElevation(url, signal);
    signal.throwIfAborted();
    const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    try {
      signal.throwIfAborted();
      if (bitmap.width !== 256 || bitmap.height !== 256) throw new Error('Invalid terrain elevation tile');
      const context = createPixelContext(256, 256);
      try {
        context.drawImage(bitmap, 0, 0);
        return decodeTerrarium(context.getImageData(0, 0, 256, 256).data);
      } finally { context.canvas.width = context.canvas.height = 0; }
    } finally { bitmap.close(); }
  }
}
