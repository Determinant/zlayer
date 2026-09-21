import { createHash } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Bounds } from '@zlayer/contracts';
import { verifyBlob } from '../src/core/storage/artifacts';
import { decompressObstructions, readObstructionFeatures } from '../src/layers/obstructions/stream';
import { project, type Segment } from '../src/layers/terrain/geometry';

// Optional module path permits a before/after run with the same parser, input,
// views and routes. Each invocation runs in a fresh process; no browser claims.
const [manifestPath, gzipPath, modulePath] = process.argv.slice(2);
if (!manifestPath || !gzipPath) throw new Error(
  'Usage: node --expose-gc --import=tsx tools/benchmark-obstructions.ts MANIFEST GZIP [INDEX_MODULE]');
const { ObstructionIndex, isObstructionManifest } = modulePath
  ? await import(pathToFileURL(resolve(modulePath)).href) as typeof import('../src/layers/obstructions/data')
  : await import('../src/layers/obstructions/data');
const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
if (!isObstructionManifest(manifest)) throw new Error('Invalid obstruction manifest');
const blob = await openAsBlob(gzipPath);
await verifyBlob(blob, { byteLength: manifest.dataset.bytes, sha256: manifest.dataset.sha256 }, 'Benchmark snapshot');
global.gc?.();
const before = process.memoryUsage(), started = performance.now();
const index = new ObstructionIndex(manifest.dataset.count);
await readObstructionFeatures(decompressObstructions(blob), manifest.dataset.uncompressedBytes, value => index.add(value));
index.finish();
const indexingMs = performance.now() - started;
global.gc?.();
const after = process.memoryUsage();
const bounds: Bounds[] = [[-180, -85, 180, 85], [-125, 30, -110, 42], [-123, 37, -121, 39],
  [-82, 24, -79, 29], [170, 45, -170, 65]];
const segments: Segment[] = [[project([-122.4, 37.6]), project([-119.8, 34.4])],
  [project([-81, 25]), project([-80, 28])], [project([179, 51]), project([181, 51])]];
const digest = createHash('sha256');
let queries = 0, returned = 0;
const queryStart = performance.now();
for (const area of bounds) for (const zoom of [3, 6.99, 7, 8, 9, 10, 13]) for (const route of [[], segments]) {
  const collection = index.query(area, route, zoom);
  digest.update(JSON.stringify(collection));
  queries++; returned += collection.features.length;
}
console.log(JSON.stringify({ dataset: manifest.dataset.sha256, sourceRecords: manifest.dataset.count,
  retainedRecords: index.size, typedBytes: index.byteLength, indexingMs, queryMs: performance.now() - queryStart,
  queries, returned, querySha256: digest.digest('hex'), gcAvailable: !!global.gc,
  before, after, peakRssKiB: process.resourceUsage().maxRSS }, null, 2));
