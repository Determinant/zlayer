import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheFixture } from './helpers/cache';
import { gridFixture } from './fixtures/awc-grids';
import { decodeGrid, type DecodedGrid } from '../src/layers/weather-awc/grids/format';
import { packGrid, unpackGrid } from '../src/layers/weather-awc/grids/packed';
import { loadRaster } from '../src/layers/weather-awc/grids/raster-cache';
import { rasterGrid } from '../src/layers/weather-awc/grids/raster';
import { fullGridViewport } from '../src/layers/weather-awc/grids/viewport';
import { weatherPerformance } from '../src/layers/weather-awc/grids/performance';

test('saved images preserve pixels, avoid recoloring on reopen, repair corruption and isolate field/source identity', async t => {
  const { stored } = cacheFixture(t, 'zlayers-plugin-files-v1:weather-awc:forecast-images');
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Rendering must not fetch weather'); });
  const fixture = gridFixture('icing'), frame = fixture.manifest.frames[1]!, signal = new AbortController().signal;
  const dense = await decodeGrid(Uint8Array.from(Buffer.from(fixture.files[frame.path]!, 'base64')).buffer, fixture.manifest, frame, signal);
  const packed = packGrid(dense.values, dense.manifest), data: DecodedGrid = { manifest: dense.manifest, frame, endpoint: 'https://first.test/',
    bands: unpackGrid(packed, dense.manifest), byteLength: packed.byteLength };
  const expected = await rasterGrid(dense, 'icingProbability', true, fullGridViewport(dense.manifest), signal);
  const draws = () => weatherPerformance().filter(sample => sample.stage === 'raster-color').length;
  assert.deepEqual(await loadRaster(data, 'icingProbability', true, signal), expected); assert.equal(draws(), 1);
  assert.deepEqual(await loadRaster({ ...data }, 'icingProbability', true, signal), expected); assert.equal(draws(), 1);
  const [key, original] = [...stored.entries()][0]!;
  stored.set(key, new Response(new ArrayBuffer(Number(original.headers.get('content-length'))), { headers: original.headers }));
  assert.deepEqual(await loadRaster(data, 'icingProbability', true, signal), expected); assert.equal(draws(), 2);
  await loadRaster({ ...data, endpoint: 'https://replacement.test/' }, 'icingProbability', true, signal);
  await loadRaster(data, 'icingSeverity', true, signal);
  await loadRaster(data, 'icingProbability', false, signal);
  assert.equal(draws(), 5); assert.equal(stored.size, 4);
});
