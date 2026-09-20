import { decodeTerrarium } from './contours';
import { createPixelContext } from '../../core/graphics/pixel-context';
import type { Tile } from './geometry';
import { TerrainWorkLimit } from './work-limit';

export const DEFAULT_ELEVATION_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const TERRAIN_ATTRIBUTION = '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">Terrain: Mapzen / USGS and contributors</a>';

/** Four network reads and 32 MiB of decoded DEMs at most, per map attachment. */
export class ElevationTiles {
  readonly #cache = new Map<string, Float32Array>();
  readonly #downloads = new TerrainWorkLimit(4);

  #cached(url: string): Float32Array | undefined {
    const values = this.#cache.get(url);
    if (values) { this.#cache.delete(url); this.#cache.set(url, values); }
    return values;
  }

  async read(tile: Tile, template: string, signal: AbortSignal): Promise<Float32Array> {
    const url = template.replace('{z}', String(tile.z)).replace('{x}', String(tile.x)).replace('{y}', String(tile.y));
    signal.throwIfAborted();
    const cached = this.#cached(url);
    if (cached) return cached;
    return this.#downloads.run(signal, async () => {
      // Another queued read may have populated this tile while we waited.
      const ready = this.#cached(url);
      if (ready) return ready;
      const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
      if (!response.ok) throw new Error(`Terrain elevation unavailable (${response.status})`);
      const bitmap = await createImageBitmap(await response.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      try {
        signal.throwIfAborted();
        if (bitmap.width !== 256 || bitmap.height !== 256) throw new Error('Invalid terrain elevation tile');
        const context = createPixelContext(256, 256);
        try {
          context.drawImage(bitmap, 0, 0);
          const values = decodeTerrarium(context.getImageData(0, 0, 256, 256).data);
          this.#cache.set(url, values);
          while (this.#cache.size > 128) this.#cache.delete(this.#cache.keys().next().value!);
          return values;
        } finally { context.canvas.width = context.canvas.height = 0; }
      } finally { bitmap.close(); }
    });
  }
}
