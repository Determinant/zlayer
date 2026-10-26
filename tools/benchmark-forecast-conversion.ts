import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createConverter } from './info-server/converter';
import { compressGrid } from '../src/layers/weather-awc/grids/packed';
import { forecastConversionFixture } from '../test/fixtures/forecast-conversion';

// Offline full-size NOAA fixtures. No network, production cache or FAA state.
const iterations = Number(process.argv[2] ?? 10);
if (!Number.isInteger(iterations) || iterations < 3 || iterations > 100) throw new Error('Use 3–100 measured iterations');
const results = [];
for (const product of ['winds', 'icing'] as const) {
  const fixture = forecastConversionFixture(product), converter = createConverter();
  for (const input of fixture.inputs) assert.equal(createHash('sha256').update(new Uint8Array(input.raw)).digest('hex'), input.sourceSha256);
  const samples: { convert: number; pack: number; gzip: number; total: number }[] = [];
  let compressedBytes = 0;
  for (let i = 0; i < iterations + 2; i++) {
    const start = performance.now();
    converter.reset(); converter.init(fixture.manifest); converter.terrain(fixture.terrain);
    for (const input of fixture.inputs) converter.field(input.field, input.raw, input.identity);
    const projected = performance.now(), { buffer } = converter.finish(), packed = performance.now();
    const compressed = await compressGrid(buffer), end = performance.now();
    assert.equal(createHash('sha256').update(new Uint8Array(buffer)).digest('hex'), fixture.packedSha256);
    compressedBytes = compressed.byteLength;
    if (i >= 2) samples.push({ convert: projected - start, pack: packed - projected, gzip: end - packed, total: end - start });
  }
  const median = (stage: keyof typeof samples[number]) => {
    const sorted = samples.map(sample => sample[stage]).sort((a, b) => a - b);
    return (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2;
  };
  results.push({ product, iterations, medianMs: { convert: median('convert'), pack: median('pack'), gzip: median('gzip'), total: median('total') },
    compressedBytes, packedSha256: fixture.packedSha256 });
}
console.log(JSON.stringify({ node: process.version, limitation: 'Synthetic sea-level terrain; excludes source acquisition, storage and concurrent services', results }, null, 2));
