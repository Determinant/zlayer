import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { isTerrainManifest, isTerrainIndex, terrainRegionKeys, terrainSpacing, terrainGridSize,
  terrainArchiveUrl, type TerrainSource } from '@zlayer/contracts';
import { readTerrainArchive } from '../src/layers/terrain/archive';
import { readPackagedElevation } from '../src/layers/terrain/packages';
import { geographicTiles, geographicSamples, packagesForElevationTile, readGeographicElevation } from '../src/layers/terrain/geographic';
import { packagesForTerrainTile, terrainSourceKey } from '../src/layers/terrain/sources';
import { ElevationTiles } from '../src/layers/terrain/elevation';
import { regionTerrainFiles } from '../src/layers/terrain/offline';
import { CHART_CACHE } from '../src/core/storage/cache-names';

const directory = new URL('./fixtures/terrain-geographic/', import.meta.url);
const files = new Map(await Promise.all((await readdir(directory)).filter(n => !n.endsWith('.md')).map(async name =>
  [name, await readFile(new URL(name, directory))] as const)));
const manifest: unknown = JSON.parse(files.get('manifest.json')!.toString());
assert.ok(isTerrainManifest(manifest));
const source: TerrainSource = { ...manifest, root: 'https://terrain.test/geographic' };
const fineDirectory = new URL('./fixtures/terrain-geographic-fine/', import.meta.url);
for (const name of (await readdir(fineDirectory)).filter(n => !n.endsWith('.md') && n !== 'manifest.json')) {
  files.set(name, await readFile(new URL(name, fineDirectory)));
}
const fineManifest: unknown = JSON.parse(await readFile(new URL('manifest.json', fineDirectory), 'utf8'));
assert.ok(isTerrainManifest(fineManifest));
const fineSource: TerrainSource = { ...fineManifest, root: 'https://terrain.test/geographic-fine' };
const bounds: [number, number, number, number][] = [[-122.01, 37.01, -122.009, 37.011]];
const signal = () => new AbortController().signal;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function storage(t: test.TestContext) {
  const saved = new Map<string, Response>();
  const key = (r: RequestInfo | URL) => typeof r === 'string' ? r : r instanceof URL ? r.href : r.url;
  const cache = { match: async (r: RequestInfo | URL) => saved.get(key(r))?.clone(),
    put: async (r: RequestInfo | URL, response: Response) => { saved.set(key(r), response.clone()); },
    delete: async (r: RequestInfo | URL) => saved.delete(key(r)) };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  Object.assign(globalThis, { caches: { open: async () => cache } });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'caches', original); else Reflect.deleteProperty(globalThis, 'caches'); });
  let online = true, requests = 0;
  t.mock.method(globalThis, 'fetch', async (request: RequestInfo | URL) => {
    requests++;
    if (!online) throw new TypeError('offline');
    const file = new URL(key(request)).pathname.split('/').at(-1)!;
    return files.has(file) ? new Response(files.get(file)!) : new Response('', { status: 404 });
  });
  return { saved, offline: () => { online = false; }, requests: () => requests };
}

for (const [fixtureSource, height] of [[source, 321], [fineSource, 654]] as const) test(`${fixtureSource.maxZoom === 10 ? 4.9 : 2.45} arc-seconds: reads builder-produced geographic archives at every level, with bounded integer heights and NoData`, async () => {
  const source = fixtureSource;
  assert.equal(source.schemaVersion, 2);
  for (const shard of source.shards) {
    const bytes = files.get(shard.file)!;
    assert.equal(hash(bytes), shard.sha256);
    const index: unknown = JSON.parse(bytes.toString());
    assert.ok(isTerrainIndex(index));
    for (const a of index.archives) {
      const bytes = files.get(a.file)!;
      assert.equal(hash(bytes), a.sha256);
      const blob = new Blob([bytes]);
      for (let quadrant = 0; quadrant < 4; quadrant++) {
        const tile = { z: a.zoom, x: a.x + quadrant % 2, y: a.y + Math.floor(quadrant / 2) };
        const values = await readTerrainArchive(blob, a, tile, signal(), 2);
        assert.equal(values[0], Math.fround(-12 / 0.3048));
        assert.ok(Number.isNaN(values[1]));
        assert.equal(values[2], Math.fround(10000 / 0.3048));
        assert.equal(values[3], Math.fround(height / 0.3048));
      }
      await assert.rejects(readTerrainArchive(blob, a, { z: a.zoom, x: a.x, y: a.y }), /Invalid terrain elevation archive/);
    }
  }
  for (const change of [{ resolutionArcSeconds: 5 }, { grid: 'EPSG:3857' }, { maxZoom: 13 }, { encoding: 'float32-feet-gzip' }]) {
    assert.equal(isTerrainManifest({ ...source, ...change }), false);
  }
  assert.equal(terrainRegionKeys(bounds, source).size, source.maxZoom);
  assert.equal(terrainRegionKeys(bounds).size, 13, 'legacy selections keep their original geometry');
});

test('geographic source pixels stay local at the date line and poles at both supported resolutions', () => {
  assert.equal(terrainSpacing(10) * 3600, 4.9);
  assert.equal(terrainSpacing(11) * 3600, 2.45);
  for (const maxZoom of [10, 11])
  for (const tile of [{ z: 13, x: 0, y: 0 }, { z: 13, x: 8191, y: 8191 }, { z: 1, x: 0, y: 0 }]) {
    const tiles = geographicTiles(tile, maxZoom);
    assert.ok(tiles.length <= 6);
    for (const t of tiles) {
      const size = terrainGridSize(t.z);
      assert.ok(t.x >= 0 && t.x < size.columns && t.y >= 0 && t.y < size.rows);
      assert.equal(t.z, Math.min(maxZoom, tile.z));
    }
  }
  const samples = geographicSamples({ z: 10, x: 512, y: 512 });
  for (let x = 1; x < 256; x++) assert.ok(samples.columns[x]! <= samples.columnEnds[x - 1]! + 1,
    'no native column can fall between adjacent display pixels');
  for (let y = 1; y < 256; y++) assert.ok(samples.rows[y]! <= samples.rowEnds[y - 1]! + 1);
});

test('geographic manifests and indices accept only aligned resolution/level pairs', () => {
  for (const format of [{ maxZoom: 10, resolutionArcSeconds: 2.45 }, { maxZoom: 11, resolutionArcSeconds: 4.9 },
    { maxZoom: 12, resolutionArcSeconds: 1.225 }]) {
    assert.equal(isTerrainManifest({ ...source, ...format }), false);
    const index = JSON.parse(files.get(source.shards[0]!.file)!.toString());
    assert.equal(isTerrainIndex({ ...index, ...format }), false);
  }
  const oldKeys = terrainRegionKeys(bounds, source), newKeys = terrainRegionKeys(bounds, fineSource);
  assert.ok([...oldKeys].every(key => newKeys.has(key)), 'the finer set extends the original levels without shifting them');
  assert.equal(newKeys.size, oldKeys.size + 1);
});

for (const [fixtureSource, height] of [[source, 321], [fineSource, 654]] as const) test(`${fixtureSource.maxZoom === 10 ? 4.9 : 2.45} arc-seconds: offline selections render close-up Mercator tiles with no PNG reads`, async t => {
  const source = fixtureSource;
  assert.equal(source.schemaVersion, 2);
  const cache = storage(t);
  const plan = await regionTerrainFiles(bounds, source, source.root, signal());
  assert.equal(plan.length, source.maxZoom * 2);
  for (const shard of source.shards) {
    const index = JSON.parse(files.get(shard.file)!.toString());
    for (const a of index.archives) await readPackagedElevation({ z: a.zoom, x: a.x, y: a.y },
      { root: source.root, shard, grid: 'EPSG:4326', maxZoom: source.maxZoom }, signal(), 2);
  }
  assert.equal(cache.saved.size, source.maxZoom * 2);
  cache.offline();
  const before = cache.requests();
  assert.deepEqual(await regionTerrainFiles(bounds, source, source.root, signal(), true), plan);
  const z = 13, x = Math.floor((-122.01 + 180) / 360 * 2 ** z);
  const y = Math.floor((1 - Math.asinh(Math.tan(37.01 * Math.PI / 180)) / Math.PI) / 2 * 2 ** z);
  const tile = { z, x, y };
  const packages = packagesForElevationTile(packagesForTerrainTile([source], tile, source.root), tile);
  assert.ok(packages.length > 0 && packages.every(p => p.grid === 'EPSG:4326' && p.shard.zoom === source.maxZoom));
  const values = await new ElevationTiles().read(tile, 'https://unexpected.test/{z}/{x}/{y}.png', signal(), packages);
  assert.ok(values.filter(Number.isFinite).length > 60000);
  assert.equal(values[128 * 256 + 128], Math.fround(height / 0.3048));
  assert.equal(cache.requests(), before, 'all inputs came from the saved archives');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readGeographicElevation(tile, packages, controller.signal), { name: 'AbortError' });
  const shard = source.shards[0]!;
  await (await caches.open(CHART_CACHE)).delete(terrainArchiveUrl(source.root, shard));
  await assert.rejects(regionTerrainFiles(bounds, source, source.root, signal(), true), /Saved terrain index is missing/);
});

test('mismatched geographic manifest and index resolutions are rejected', async t => {
  storage(t);
  await assert.rejects(regionTerrainFiles(bounds, { ...fineSource, shards: source.shards }, source.root, signal()),
    /Terrain index format disagrees/);
  const shard = source.shards.find(s => s.zoom === 10)!;
  const archive = JSON.parse(files.get(shard.file)!.toString()).archives[0];
  await assert.rejects(readPackagedElevation({ z: archive.zoom, x: archive.x, y: archive.y },
    { root: source.root, shard, grid: 'EPSG:4326', maxZoom: 11 }, signal(), 2), /Terrain grid format mismatch/);
});

test('saved source precedence remains stable across the geographic format transition', () => {
  const tile = { z: 13, x: 1319, y: 3188 };
  const a = { zoom: 13, x: Math.floor(tile.x / 64) * 64, y: Math.floor(tile.y / 64) * 64,
    sha256: 'a'.repeat(64), file: `${'a'.repeat(64)}.terrain`, byteLength: 100 };
  const legacy: TerrainSource = { schemaVersion: 1, encoding: 'float32-feet-gzip', minZoom: 1, maxZoom: 13,
    generatedAt: source.generatedAt, root: 'https://terrain.test/legacy', shards: [a] };
  const select = (sources: TerrainSource[]) => packagesForElevationTile(packagesForTerrainTile(sources, tile, source.root), tile);
  const key = (sources: TerrainSource[]) => terrainSourceKey(sources, source.root);
  assert.equal(select([legacy, source])[0]!.root, legacy.root);
  assert.equal(select([source, legacy])[0]!.root, source.root);
  assert.notEqual(key([legacy, source]), key([source, legacy]), 'switching grid precedence must invalidate rendered tiles');
  const equivalent = { ...source, generatedAt: '2026-09-20T00:00:00Z', shards: [...source.shards].reverse() };
  assert.equal(key([legacy, source]), key([legacy, equivalent]));
  assert.equal(key([legacy, source]), key([legacy, { ...source, shards: [] }, source]));
  assert.equal(key([legacy, source]), key([legacy, source, { ...legacy, root: '/shadowed' }]));
  assert.equal(key([source, legacy]), key([source, legacy, { ...source, root: '/shadowed' }]));

  // Sources of the same format can occur on both sides of the other format.
  const elsewhere = { ...legacy, shards: [{ ...a, x: a.x + 64 }] };
  assert.equal(select([elsewhere, source, legacy])[0]!.root, source.root);
  assert.equal(select([elsewhere, legacy, source])[0]!.root, legacy.root);
  assert.notEqual(key([elsewhere, source, legacy]), key([elsewhere, legacy, source]));
});

test('saved geographic resolution wins over browsing data without mixing native levels', async t => {
  storage(t);
  const tile = { z: 13, x: 1319, y: 3188 };
  const select = (sources: TerrainSource[]) => packagesForElevationTile(packagesForTerrainTile(sources, tile, source.root), tile);
  const key = (sources: TerrainSource[]) => terrainSourceKey(sources, source.root);
  for (const [sources, zoom, height] of [[[source, fineSource], 10, 321], [[fineSource, source], 11, 654]] as const) {
    const packages = select([...sources]);
    assert.ok(packages.length && packages.every(p => p.shard.zoom === zoom));
    const values = await new ElevationTiles().read(tile, 'https://unexpected.test/{z}/{x}/{y}.png', signal(), packages);
    assert.equal(values[128 * 256 + 128], Math.fround(height / 0.3048));
  }
  assert.notEqual(key([source, fineSource]), key([fineSource, source]));
  const equivalent = { ...fineSource, generatedAt: '2026-09-22T00:00:00Z', shards: [...fineSource.shards].reverse() };
  assert.equal(key([source, fineSource]), key([source, equivalent]));
  assert.equal(key([source, fineSource]), key([source, fineSource, { ...fineSource, root: '/shadowed' }]));
  const elsewhere = { ...fineSource, shards: fineSource.shards.filter(s => s.zoom < 11) };
  assert.ok(select([elsewhere, source]).every(p => p.shard.zoom === 10), 'unavailable finer coverage must not hide saved terrain');
});

for (const height of [9322, -32768]) test(`Mercator footprints preserve ${height === -32768 ? 'NoData' : 'peaks'} between pixel centres`, async t => {
  storage(t);
  const tile = { z: 10, x: 164, y: 398 }, samples = geographicSamples(tile);
  const shard = source.shards.find(s => s.zoom === 10)!;
  const index = JSON.parse(files.get(shard.file)!.toString()), archive = index.archives[0];
  // Change one contributing cell, keeping the rest of the footprint inside the
  // archive and clear of the fixture's first-row NoData samples.
  const px = samples.columns.findIndex((start, i) => samples.columnEnds[i]! > start &&
    start >= archive.x * 256 + 4 && samples.columnEnds[i]! < (archive.x + 2) * 256);
  const py = samples.rows.findIndex((row, i) => row > archive.y * 256 && samples.rowEnds[i]! < (archive.y + 1) * 256);
  assert.ok(px >= 0 && py >= 0);
  const column = samples.columnEnds[px]!, row = samples.rows[py]!;
  const quadrant = (Math.floor(row / 256) - archive.y) * 2 + Math.floor(column / 256) - archive.x;
  const original = files.get(archive.file)!, header = Buffer.from(original.subarray(0, 56));
  const parts = Array.from({ length: 4 }, (_, i) => {
    const offset = header.readUInt32LE(24 + i * 8), length = header.readUInt32LE(28 + i * 8);
    const grid = gunzipSync(original.subarray(offset, offset + length));
    if (i === quadrant) grid.writeInt16LE(height, ((row % 256) * 256 + column % 256) * 2);
    return gzipSync(grid);
  });
  let offset = 56;
  parts.forEach((part, i) => { header.writeUInt32LE(offset, 24 + i * 8); header.writeUInt32LE(part.length, 28 + i * 8); offset += part.length; });
  const bytes = Buffer.concat([header, ...parts]), demSha = hash(bytes), demFile = `${demSha}.dem`;
  index.archives[0] = { ...archive, sha256: demSha, file: demFile, byteLength: bytes.length };
  const json = Buffer.from(JSON.stringify(index)), indexSha = hash(json), indexFile = `${indexSha}.terrain`;
  files.set(demFile, bytes); files.set(indexFile, json);
  t.after(() => { files.delete(demFile); files.delete(indexFile); });
  const changed = { ...source, root: `https://terrain.test/geographic-sample-${height}`,
    shards: [{ ...shard, file: indexFile, sha256: indexSha, byteLength: json.length }] };
  const packages = packagesForElevationTile(packagesForTerrainTile([changed],
    { z: 9, x: Math.floor(tile.x / 2), y: Math.floor(tile.y / 2) }, changed.root), tile);
  const values = await readGeographicElevation(tile, packages, signal());
  assert.equal(values[py * 256 + px], height === -32768 ? NaN : Math.fround(height / 0.3048));
  assert.equal(values[py * 256 + px + 4], Math.fround(321 / 0.3048), 'nearby complete footprints remain valid');
  const edge = samples.columns.findIndex((start, i) => start < archive.x * 256 && samples.columnEnds[i]! >= archive.x * 256);
  assert.ok(edge >= 0);
  assert.ok(Number.isNaN(values[py * 256 + edge]), 'a footprint spanning a missing neighbouring archive stays unknown');
});
