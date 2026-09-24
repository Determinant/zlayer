import { GridClient } from '../../src/layers/weather-awc/grids/client';
import { gridCell, gridValue, gridReader, gridKey } from '../../src/layers/weather-awc/grids/format';
import type { AwcGridProduct } from '@zlayer/contracts';
import type { ForecastFrame, ForecastManifest } from '../../src/layers/weather-awc/grids/native-source';
import { windFrames } from '../../src/layers/weather-awc/grids/wind-levels';
import { nativeSourceUrl, nativeManifest } from '../../src/layers/weather-awc/grids/native-source';
import { pluginFileKey } from '../../src/core/storage/plugin-file-cache';
import { compressGrid } from '../../src/layers/weather-awc/grids/packed';
const client = new GridClient(new URL('/api/weather/grids/', location.href).href, true);
async function loadFrame(product: AwcGridProduct, online: boolean, select: (manifest: ForecastManifest) => ForecastFrame | undefined) {
  const signal = new AbortController().signal;
  const manifest = online ? await client.refresh(product, signal) : client.restore(product).manifest;
  if (!manifest) throw new Error('No saved forecast metadata');
  const frame = select(manifest);
  if (!frame) throw new Error('No matching forecast frame');
  const data = await client.load(manifest, frame, signal, online);
  if (online && client.saved(data)) client.remember(manifest);
  const cell = gridCell(manifest, -100, 38)!;
  return { values: manifest.fields.map(field => gridValue(data, field, cell)), frames: manifest.frames.length };
}
const api = {
  async legacyCloud() {
    const manifest = client.restore('clouds').manifest!;
    if (!nativeManifest(manifest)) throw new Error('Expected native fixture');
    const frame = manifest.frames[1]!, data = await client.load(manifest, frame, new AbortController().signal, false);
    const count = manifest.grid.width * manifest.grid.height, raw = new ArrayBuffer(16 + count * manifest.fields.length * 4);
    new Uint8Array(raw, 0, 8).set(new TextEncoder().encode('ZAWCGRID'));
    const header = new DataView(raw); header.setUint16(8, 1, true); header.setUint16(10, manifest.grid.width, true);
    header.setUint16(12, manifest.grid.height, true); header.setUint16(14, manifest.fields.length, true);
    for (const [band, field] of manifest.fields.entries()) {
      const read = gridReader(data, field);
      for (let cell = 0; cell < count; cell++) header.setFloat32(16 + (band * count + cell) * 4, read(cell), true);
    }
    const encoded = await compressGrid(raw), digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoded))]
      .map(value => value.toString(16).padStart(2, '0')).join('');
    const cache = await caches.open('zlayers-plugin-files-v1:weather-awc:converted-grids');
    const url = nativeSourceUrl(client.baseUrl, frame.records.cloudCover!.path), identity = gridKey(manifest, frame);
    const modernKey = pluginFileKey({ url, identity: `packed-v1/${identity}` }), response = (await cache.match(modernKey))!;
    const headers = new Headers(response.headers); headers.set('content-length', String(encoded.byteLength)); headers.set('x-zlayer-file-sha256', digest);
    await cache.put(pluginFileKey({ url, identity }), new Response(encoded, { headers }));
    await cache.delete(modernKey);
  },
  async load(product: AwcGridProduct, online: boolean, altitude = 8000, lead = 1) {
    return loadFrame(product, online, manifest => manifest.frames.find(f => f.validTime === manifest.runTime + lead * 3600000 &&
      (product === 'winds' ? f.pressureHpa === altitude : product === 'clouds' || f.altitudeFtMsl === altitude)));
  },
  async wind(altitude: number, online: boolean) {
    return loadFrame('winds', online, manifest => windFrames(manifest, altitude).find(f => f.validTime === manifest.runTime + 3600000));
  },
};
declare global { interface Window { nativeWeather: typeof api } }
window.nativeWeather = api;
