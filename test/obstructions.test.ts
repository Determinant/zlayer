import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { ObstructionIndex, isObstructionManifest } from '../src/layers/obstructions/data';
import { decompressObstructions, readObstructionFeatures } from '../src/layers/obstructions/stream';
import { parseObstructions, loadObstructions } from '../src/layers/obstructions/api';
import { obstructionIcon, obstructionMinHeight, obstructionMinZoom, OBSTRUCTION_MIN_ZOOM } from '../src/layers/obstructions/definitions';
import { VFR_WAYPOINT_MIN_ZOOM } from '../src/layers/navigation/definitions';
import { project, type Segment } from '../src/layers/terrain/geometry';
import type { ObstructionFeature, ObstructionManifest } from '../src/layers/obstructions/types';
import { cacheFixture } from './helpers/cache';
import { VERIFIED_SHA256_HEADER } from '../src/core/storage/cache-names';

const feature = (id: string, lon = 0, lat = 0): ObstructionFeature => ({ type: 'Feature', id,
  geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { heightAglFt: 500,
    elevationMslFt: 500, verified: true, lightingCode: 'N', quantity: 1, structureType: 'TOWER' } });
const segment = (a: [number, number], b: [number, number]): Segment => [project(a), project(b)];
function fixture(features = [feature('06-000001')]) {
  const json = JSON.stringify({ type: 'FeatureCollection', features });
  const bytes = gzipSync(json), sha256 = createHash('sha256').update(bytes).digest('hex');
  const manifest: ObstructionManifest = { schemaVersion: 1, generatedAt: '2026-09-19T00:00:00Z', horizontalDatum: 'WGS84',
    source: { name: 'FAA Daily DOF', lastModified: '2026-09-18T00:00:00Z' }, dataset: {
      path: `obstacles-${sha256}.geojson.gz`, sha256, format: 'geojson', compression: 'gzip',
      bytes: bytes.length, uncompressedBytes: Buffer.byteLength(json), count: features.length } };
  return { json, bytes, manifest, blob: new Blob([new Uint8Array(bytes)]) };
}

test('height tiers expand outward from VPxxx detail and keep FAA symbol distinctions', () => {
  assert.equal(obstructionMinZoom(500), VFR_WAYPOINT_MIN_ZOOM);
  assert.equal(OBSTRUCTION_MIN_ZOOM, VFR_WAYPOINT_MIN_ZOOM - 3);
  assert.equal(obstructionMinZoom(499), undefined);
  assert.equal(obstructionMinHeight(6.99), undefined);
  for (const [zoom, height] of [[7, 2000], [7.99, 2000], [8, 1500], [8.99, 1500], [9, 1000], [9.99, 1000], [10, 500], [13, 500]]) {
    assert.equal(obstructionMinHeight(zoom!), height);
  }
  assert.equal(obstructionIcon(999, 1, 'R', 'TOWER'), 'obstruction-low-single-plain');
  assert.equal(obstructionIcon(1000, 2, 'H', 'TOWER'), 'obstruction-tall-group-strobe');
  assert.equal(obstructionIcon(400, 1, 'S', 'WIND TURBINE'), 'obstruction-wind-single-strobe');
  for (const code of ['N', 'U', 'R', 'D', 'M', 'F', 'C', 'W', 'L']) {
    assert.ok(obstructionIcon(500, 2, code, 'WINDMILL').endsWith('-plain'));
  }
});

test('zoom selects inclusive AGL height tiers independently of MSL elevation', () => {
  const heights = [499, 500, 999, 1000, 1499, 1500, 1999, 2000, 2500];
  const index = new ObstructionIndex(heights.length);
  heights.forEach((height, i) => {
    const point = feature(`06-${String(i + 1).padStart(6, '0')}`);
    point.properties.heightAglFt = height;
    point.properties.elevationMslFt = height < 1000 ? 12000 : height;
    index.add(point);
  });
  index.finish();
  const selected = (zoom: number) => index.query([-1, -1, 1, 1], [], zoom).features;
  for (const zoom of [6.99, NaN, Infinity]) assert.deepEqual(selected(zoom), []);
  for (const zoom of [7, 7.99]) assert.deepEqual(selected(zoom).map(point => point.properties.heightAglFt), [2000, 2500]);
  for (const zoom of [8, 8.99]) assert.deepEqual(selected(zoom).map(point => point.properties.heightAglFt), [1500, 1999, 2000, 2500]);
  for (const zoom of [9, 9.99]) assert.deepEqual(selected(zoom).map(point => point.properties.heightAglFt), [1000, 1499, 1500, 1999, 2000, 2500]);
  for (const zoom of [10, 13]) {
    assert.deepEqual(selected(zoom).map(point => point.properties.heightAglFt), heights.slice(1));
    assert.deepEqual(selected(zoom).map(point => point.properties.minZoom), [10, 10, 9, 9, 8, 8, 7, 7]);
  }
  assert.deepEqual(index.query([-1, -1, 1, 1], [segment([-1, 0], [1, 0])], 3).features
    .map(point => point.properties.heightAglFt), heights.slice(1), 'the route keeps the 500 ft floor at wider zooms');
});

test('the corridor adds a 4 NM core and 8 NM fade at wider zooms without restricting close views', () => {
  const index = new ObstructionIndex(5);
  [feature('06-000001', 0, 3 / 60), feature('06-000002', 0, 6 / 60), feature('06-000003', 0, 9 / 60),
    feature('06-000004', 2, 0), feature('AA-00ZZ01', 0, 0)].forEach(point => index.add(point));
  index.finish();
  const segments = [segment([-1, 0], [1, 0])];
  const selected = index.query([-3, -1, 3, 1], segments, 6.99).features;
  assert.deepEqual(selected.map(point => point.id).sort(), ['06-000001', '06-000002', 'AA-00ZZ01']);
  assert.equal(selected.find(point => point.id === '06-000001')!.properties.routeOpacity, 1);
  assert.ok(Math.abs(selected.find(point => point.id === '06-000002')!.properties.routeOpacity - 0.5) < 0.005);
  assert.equal(index.query([-3, -1, 3, 1], [], 6.99).features.length, 0);
  assert.equal(index.query([1.5, -1, 3, 1], segments, 6.99).features.length, 0);
  assert.equal(index.query([-3, -1, 3, 1], [segment([-2, 0], [-1, 0]), segment([1, 0], [2, 0])], 6.99).features.length, 1,
    'unresolved gaps must not be bridged');
  assert.equal(index.query([-3, -1, 3, 1], segments, 10).features.length, 5);
  assert.equal(index.query([-3, -1, 3, 1], [], 10).features.length, 5);
  assert.equal(index.query([-1, -1, 1, 1], [], 10).features.length, 4, 'background points still clip to the viewport');
});

test('the Walnut Grove towers near KSAC appear without a route and outside an unrelated route corridor', () => {
  // Published FAA Daily DOF records, 2026-09-18.
  const towers = [
    ['06-001883', -121.501945, 38.24, 2049], ['06-000054', -121.501667, 38.247223, 1549],
    ['06-001467', -121.490278, 38.264723, 2000], ['06-001884', -121.506112, 38.271667, 2030],
  ] as const;
  const index = new ObstructionIndex(towers.length);
  for (const [id, lon, lat, height] of towers) {
    const point = feature(id, lon, lat); point.properties.heightAglFt = height; index.add(point);
  }
  index.finish();
  for (const segments of [[], [segment([-122.35, 37.5], [-121.85, 37.5])]]) {
    const selected = index.query([-121.6, 38.2, -121.4, 38.35], segments, 7).features;
    assert.deepEqual(selected.map(point => point.id).sort(), ['06-001467', '06-001883', '06-001884']);
    assert.ok(selected.every(point => point.properties.routeOpacity === 0));
    assert.equal(index.query([-121.6, 38.2, -121.4, 38.35], segments, 8).features.length, 4);
  }
});

test('wrapped routes and viewports include both sides of the dateline without duplicate features', () => {
  const index = new ObstructionIndex(2);
  index.add(feature('AK-000001', 179.98, 51)); index.add(feature('AK-000002', -179.98, 51)); index.finish();
  const segments = [segment([179.8, 51], [-179.8, 51])];
  segments[0]![1][0] += 1;
  for (const bounds of [[179, 50.9, -179, 51.1], [179, 50.9, 181, 51.1], [-181, 50.9, -179, 51.1]] as const) {
    assert.equal(index.query([...bounds], segments, 6.99).features.length, 2);
    assert.equal(index.query([...bounds], [], 10).features.length, 2);
  }
});

test('obstruction decompression bounds blob reads independently of browser stream chunking', async () => {
  const points = Array.from({ length: 64 }, (_, i) => {
    const point = feature(`06-${String(i + 1).padStart(6, '0')}`);
    point.properties.structureType = randomBytes(2048).toString('base64');
    return point;
  });
  const { bytes, json } = fixture(points), reads: number[] = [];
  const blob = new Blob([new Uint8Array(bytes)]);
  Object.defineProperty(blob, 'stream', { value: () => { throw new Error('Unbounded browser chunking'); } });
  const slice = blob.slice.bind(blob);
  Object.defineProperty(blob, 'slice', { value: (start: number, end: number) => {
    reads.push(end - start); return slice(start, end);
  } });
  const actual: unknown[] = [];
  await readObstructionFeatures(decompressObstructions(blob), Buffer.byteLength(json), item => actual.push(item));
  assert.deepEqual(actual, points);
  assert.ok(reads.length > 1, 'fixture must span multiple compressed reads');
  assert.ok(reads.every(size => size > 0 && size <= 64 * 1024));
  assert.equal(reads.reduce((sum, size) => sum + size, 0), bytes.length);
});

test('streaming handles split UTF-8, escapes and braces without keeping the whole JSON', async () => {
  const point = feature('06-000001');
  point.properties.structureType = 'TOWER "quoted" \\ { },[] café';
  const { json } = fixture([point]);
  const bytes = new TextEncoder().encode(json);
  for (const size of [1, 7, 4096]) {
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset + size)); offset = Math.min(bytes.length, offset + size);
    } });
    const read: unknown[] = [];
    await readObstructionFeatures(stream, bytes.length, item => read.push(item));
    assert.deepEqual(read, [point]);
  }
  for (const invalid of [json.slice(0, -1), json.replace(']}', ',]}'), json + 'garbage', json.replace('"FeatureCollection"', '"Nope"')]) {
    await assert.rejects(readObstructionFeatures(new Blob([invalid]).stream(), Buffer.byteLength(invalid), () => {}));
  }
});

test('published hashes, sizes, counts and records are validated before using a snapshot', async () => {
  const point = feature('06-000001'); Object.assign(point.properties, { verified: false, elevationMslFt: -15 });
  const { blob, manifest } = fixture([point]);
  assert.ok(isObstructionManifest(manifest));
  assert.ok(!isObstructionManifest({ ...manifest, dataset: { ...manifest.dataset, path: '../elsewhere.gz' } }));
  const index = await parseObstructions(blob, manifest);
  assert.equal(index.query([-1, -1, 1, 1], [segment([-1, 0], [1, 0])], 10).features[0]!.properties.label, '-15 UC\n(500)');
  const lowPoint = structuredClone(point); lowPoint.properties.heightAglFt = 0;
  const lowFile = fixture([lowPoint]);
  const lowIndex = await parseObstructions(lowFile.blob, lowFile.manifest);
  assert.equal(lowIndex.query([-1, -1, 1, 1], [segment([-1, 0], [1, 0])], 13).features.length, 0);
  for (const patch of [{ bytes: blob.size + 1 }, { sha256: '0'.repeat(64) }, { count: 2 }, { uncompressedBytes: 1 }]) {
    await assert.rejects(parseObstructions(blob, { ...manifest, dataset: { ...manifest.dataset, ...patch } }));
  }
  const duplicate = fixture([point, point]);
  await assert.rejects(parseObstructions(duplicate.blob, duplicate.manifest), /Duplicate/);
  const invalid = structuredClone(point); invalid.geometry.coordinates = [181, 0];
  const invalidFile = fixture([invalid]);
  await assert.rejects(parseObstructions(invalidFile.blob, invalidFile.manifest), /Invalid/);
});

test('the rolling manifest resolves and verifies its immutable gzip dataset', async t => {
  const { bytes, manifest } = fixture();
  const requested: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    requested.push(url);
    return url.endsWith('manifest.json') ? Response.json(manifest) : new Response(new Uint8Array(bytes));
  });
  const result = await loadObstructions('https://charts.test/charts/obstacles/manifest.json');
  assert.deepEqual(requested, ['https://charts.test/charts/obstacles/manifest.json', `https://charts.test/charts/obstacles/${manifest.dataset.path}`]);
  assert.equal(result.sourceDate, manifest.source.lastModified);
  assert.equal(result.index.query([-1, -1, 1, 1], [segment([-1, 0], [1, 0])], 10).features.length, 1);
});

test('obstruction downloads hash once and cold cache reads reuse a receipt while rebuilding the index', async t => {
  const { stored } = cacheFixture(t);
  const { bytes, manifest } = fixture();
  const manifestUrl = 'https://charts.test/obstacles/manifest.json';
  const url = new URL(manifest.dataset.path, manifestUrl).href;
  const fetch = t.mock.method(globalThis, 'fetch', async (url: string) =>
    url === manifestUrl ? Response.json(manifest) : new Response(new Uint8Array(bytes)));
  // Hashing and bounded decompression each read the compressed blob once.
  let readBytes = 0;
  const slice = Blob.prototype.slice;
  t.mock.method(Blob.prototype, 'slice', function (this: Blob, start?: number, end?: number, type?: string) {
    const part = slice.call(this, start, end, type);
    readBytes += part.size;
    return part;
  });
  await loadObstructions(manifestUrl);
  assert.equal(readBytes, 2 * bytes.length);
  assert.equal(stored.get(url)!.headers.get(VERIFIED_SHA256_HEADER), manifest.dataset.sha256);
  fetch.mock.mockImplementation(async () => { throw new TypeError('offline'); });
  const { index } = await loadObstructions(manifestUrl);
  assert.equal(index.query([-1, -1, 1, 1], [], 10).features.length, 1);
  assert.equal(readBytes, 3 * bytes.length, 'cold loads only read the gzip for decompression');

  // A legacy entry without a receipt is verified once, then upgraded atomically.
  stored.set(url, new Response(new Uint8Array(bytes)));
  await loadObstructions(manifestUrl);
  assert.equal(readBytes, 5 * bytes.length);
  await loadObstructions(manifestUrl);
  assert.equal(readBytes, 6 * bytes.length);
});

test('obstruction network headers cannot bypass hashing, and invalid receipts are reverified', async t => {
  const { stored } = cacheFixture(t);
  const { bytes, manifest } = fixture();
  const manifestUrl = 'https://charts.test/obstacles/manifest.json';
  const url = new URL(manifest.dataset.path, manifestUrl).href;
  const corrupted = new Uint8Array(bytes); corrupted[corrupted.length - 1]! ^= 1;
  const headers = { 'content-length': String(bytes.length), [VERIFIED_SHA256_HEADER]: manifest.dataset.sha256 };
  const fetch = t.mock.method(globalThis, 'fetch', async (url: string) =>
    url === manifestUrl ? Response.json(manifest) : new Response(corrupted, { headers }));
  await assert.rejects(loadObstructions(manifestUrl), /SHA-256 mismatch/);
  assert.equal(stored.has(url), false);
  stored.set(url, new Response(new Uint8Array(bytes), { headers: { ...headers, [VERIFIED_SHA256_HEADER]: 'a'.repeat(64) } }));
  fetch.mock.mockImplementation(async () => { throw new TypeError('offline'); });
  await loadObstructions(manifestUrl);
  assert.equal(stored.get(url)!.headers.get(VERIFIED_SHA256_HEADER), manifest.dataset.sha256);
});

test('an unreadable obstruction cache is kept when a network repair is unavailable', async t => {
  const { stored, cache } = cacheFixture(t);
  const { bytes, manifest } = fixture();
  const manifestUrl = 'https://charts.test/obstacles/manifest.json';
  const url = new URL(manifest.dataset.path, manifestUrl).href;
  stored.set(manifestUrl, Response.json(manifest));
  stored.set(url, new Response(new Uint8Array(bytes)));
  const match = cache.match;
  t.mock.method(cache, 'match', async (request: RequestInfo | URL) => {
    const response = await match(request);
    if (String(request) === url && response) response.blob = async () => { throw new DOMException('busy', 'NotReadableError'); };
    return response;
  });
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('offline'); });
  await assert.rejects(loadObstructions(manifestUrl), /offline/);
  assert.equal(stored.has(url), true);
});
