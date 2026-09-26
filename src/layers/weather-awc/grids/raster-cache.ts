import type { AwcGridField } from '@zlayer/contracts';
import { createTaskLimiter } from '../../../core/data/task-limiter';
import { pluginStorage } from '../storage';
import { gridKey, type DecodedGrid } from './format';
import { compressGrid, inflateGridBytes } from './packed';
import { rasterGrid } from './raster';
import { fullGridViewport } from './viewport';
import { weatherTiming } from './performance';

// Optional display artifacts use AWC's disposable pool. They never establish
// numeric/offline readiness, source freshness or point-inspection values.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const images = pluginStorage.files('forecast-images', {
  maxEntries: 24, maxBytes: 32 * 1024 * 1024, maxFileBytes: MAX_IMAGE_BYTES, maxUnusedMs: 48 * 3600000,
});
const render = createTaskLimiter(1);

export function loadRaster(data: DecodedGrid, field: AwcGridField, sld: boolean, signal: AbortSignal,
  onReady?: (pixels: Uint8ClampedArray<ArrayBuffer>) => void): Promise<Uint8ClampedArray<ArrayBuffer>> {
  const view = fullGridViewport(data.manifest);
  // Increment when palette, transparency, hatch or sampling rules change.
  const identity = JSON.stringify(['rgba-v1', data.endpoint, gridKey(data.manifest, data.frame), field, sld]);
  let fresh: { bytes: ArrayBuffer; pixels: Uint8ClampedArray<ArrayBuffer> } | undefined;
  // This source address is a persistent cache identifier, never a network route.
  return images.derive({ url: new URL('/weather/awc/derived-image', globalThis.location?.href ?? 'https://zlayer.invalid').href,
    identity, label: 'Forecast image', signal, run: render, ...(onReady ? { onReady } : {}),
    async create(signal, ready) {
      const done = weatherTiming('raster-color');
      let pixels: Uint8ClampedArray<ArrayBuffer>;
      try { pixels = await rasterGrid(data, field, sld, view, signal); }
      finally { done(); }
      ready(pixels);
      try {
        const bytes = await compressGrid(pixels.buffer, signal); signal.throwIfAborted();
        if (bytes.byteLength > MAX_IMAGE_BYTES) return { value: pixels };
        fresh = { bytes, pixels }; return bytes;
      } catch { signal.throwIfAborted(); return { value: pixels }; }
    },
    async validate(bytes, signal) {
      if (fresh?.bytes === bytes) return fresh.pixels;
      const done = weatherTiming('raster-cache');
      try {
        const expected = view.width * view.height * 4, buffer = await inflateGridBytes(bytes, expected, signal);
        signal.throwIfAborted();
        if (buffer.byteLength !== expected) throw new Error('Forecast image size mismatch');
        return new Uint8ClampedArray(buffer);
      } finally { done(); }
    },
  });
}
