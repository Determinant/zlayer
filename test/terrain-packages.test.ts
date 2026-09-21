import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isTerrainManifest, isTerrainIndex, terrainArchiveUrl, terrainRegionKeys, type TerrainSource } from '@zlayer/contracts';
import { readTerrainArchive } from '../src/layers/terrain/archive';
import { readPackagedElevation, readTerrainIndex } from '../src/layers/terrain/packages';
import { regionTerrainFiles } from '../src/layers/terrain/offline';
import { prepareRegionTerrain, terrainFilesIncluded } from '../src/offline/terrain';
import { cachedFileBytes } from '../src/offline/storage';
import { RegionDownloads, type DownloadPlan } from '../src/offline/downloads';
import { isDownloadPlan } from '../src/offline/plan-records';
import { fetchElevation } from '../src/layers/terrain/fetch';

const fixtures = new URL('./fixtures/terrain/', import.meta.url);
const fixture = (file: string) => readFile(new URL(file, fixtures));
const manifest = JSON.parse((await fixture('manifest.json')).toString()) as TerrainSource;
const bounds: [number, number, number, number][] = [[-122.01, 37.01, -122.009, 37.011]];
const signal = () => new AbortController().signal;

test('consumer reads actual faa-regs output without PNG/canvas decoding, preserving every sample', async () => {
  assert.ok(isTerrainManifest(manifest));
  for (const shard of manifest.shards) {
    const bytes = await fixture(shard.file);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), shard.sha256);
    const index: unknown = JSON.parse(bytes.toString());
    assert.ok(isTerrainIndex(index));
    for (const archive of index.archives) {
      const blob = new Blob([await fixture(archive.file)]);
      for (let i = 0; i < 4; i++) {
        const values = await readTerrainArchive(blob, archive, { z: archive.zoom, x: archive.x + i % 2, y: archive.y + Math.floor(i / 2) });
        assert.equal(values[0], Math.fround(123.5 / 0.3048));
        assert.equal(values[1], Math.fround(-0.25 / 0.3048));
        assert.ok(Number.isNaN(values[2]));
        assert.ok(values.slice(3).every(value => value === 0));
      }
      const broken = new Uint8Array(await blob.arrayBuffer()); broken[24] = 0;
      await assert.rejects(readTerrainArchive(new Blob([broken]), archive, { z: archive.zoom, x: archive.x, y: archive.y }));
      await assert.rejects(readTerrainArchive(blob, archive, { z: archive.zoom, x: archive.x + 2, y: archive.y }));
    }
  }
  assert.equal(isTerrainManifest({ ...manifest, shards: [...manifest.shards, manifest.shards[0]] }), false);
  assert.equal(isTerrainManifest({ ...manifest, shards: [{ ...manifest.shards[0], file: '../bad.terrain' }] }), false);
  assert.equal(isTerrainManifest({ ...manifest, minZoom: 2 }), false);
});

function storage(t: test.TestContext, files = new Map<string, Uint8Array>()) {
  const saved = new Map<string, Response>();
  const key = (request: RequestInfo | URL) => typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
  const cache = { match: async (r: RequestInfo | URL) => {
    const response = saved.get(key(r));
    // Cache Storage returns independent bodies, not a tee that waits for an
    // unread sibling when the consumer cancels an invalid stored response.
    return response && new Response(await response.clone().blob(), { status: response.status, headers: response.headers });
  },
    put: async (r: RequestInfo | URL, response: Response) => { saved.set(key(r), response.clone()); },
    delete: async (r: RequestInfo | URL) => saved.delete(key(r)) };
  const originals = ['caches', 'location'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  Object.assign(globalThis, { caches: { open: async () => cache }, location: { href: 'https://terrain.test/' } });
  t.after(() => { for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  } });
  let online = true, requests = 0;
  t.mock.method(globalThis, 'fetch', async (request: RequestInfo | URL) => {
    requests++;
    if (!online) throw new TypeError('offline');
    const file = new URL(key(request)).pathname.split('/').at(-1)!;
    return new Response((files.get(file) ?? await fixture(file)) as Uint8Array<ArrayBuffer>);
  });
  return { saved, offline: () => { online = false; }, requests: () => requests };
}

async function indexFixture(label: string) {
  const original = manifest.shards.find(shard => shard.zoom === 13)!;
  const data = JSON.parse((await fixture(original.file)).toString());
  const bytes = Buffer.from(JSON.stringify({ ...data, label }));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const shard = { ...original, sha256, file: `${sha256}.terrain`, byteLength: bytes.length };
  return { root: `https://terrain.test/${label}`, shard, bytes };
}

function countParses(t: test.TestContext) {
  let count = 0;
  const text = Blob.prototype.text;
  t.mock.method(Blob.prototype, 'text', async function(this: Blob) { count++; return text.call(this); });
  return () => count;
}

test('four native elevation tiles share one parsed index, including concurrent reads', async t => {
  const cache = storage(t), shard = manifest.shards.find(shard => shard.zoom === 13)!;
  const a = JSON.parse((await fixture(shard.file)).toString()).archives[0];
  const source = { root: 'https://terrain.test/shared-index', shard };
  let parses = 0;
  const text = Blob.prototype.text;
  t.mock.method(Blob.prototype, 'text', async function(this: Blob) { parses++; return text.call(this); });
  const values = await Promise.all(Array.from({ length: 4 }, (_, i) => readPackagedElevation({
    z: a.zoom, x: a.x + i % 2, y: a.y + Math.floor(i / 2),
  }, source, signal())));
  assert.ok(values.every(value => value[0] === Math.fround(123.5 / 0.3048)));
  assert.equal(parses, 1); assert.equal(cache.requests(), 2, 'one index and one shared archive');
  const index = await readTerrainIndex(source, signal());
  assert.equal(await readTerrainIndex(source, signal()), index);
  assert.equal(parses, 1);
});

test('parsed terrain indices remain bounded and recently used entries survive eviction', async t => {
  const sources = await Promise.all(Array.from({ length: 9 }, (_, i) => indexFixture(`bounded-${i}`)));
  storage(t, new Map(sources.map(source => [source.shard.file, source.bytes])));
  const parses = countParses(t);
  const first = await readTerrainIndex(sources[0]!, signal());
  for (const source of sources.slice(1, 8)) await readTerrainIndex(source, signal());
  assert.equal(await readTerrainIndex(sources[0]!, signal()), first);
  await readTerrainIndex(sources[8]!, signal());
  assert.equal(await readTerrainIndex(sources[0]!, signal()), first, 'a hit retains the recently used entry');
  assert.equal(parses(), 9);
  await readTerrainIndex(sources[1]!, signal());
  assert.equal(parses(), 10, 'the least recently used entry must have been released');
});

test('warm parsed terrain does not conceal storage eviction or invalid receipts and normal reads repair storage', async t => {
  const source = await indexFixture('eviction');
  const cache = storage(t, new Map([[source.shard.file, source.bytes]])), parses = countParses(t);
  const url = terrainArchiveUrl(source.root, source.shard);
  const index = await readTerrainIndex(source, signal());
  cache.offline();
  cache.saved.delete(url);
  await assert.rejects(readTerrainIndex(source, signal(), true), /Saved terrain index is missing/);
  assert.equal(cache.requests(), 1, 'health checks cannot fetch or repair');
  assert.equal(await readTerrainIndex(source, signal()), index);
  assert.ok(cache.saved.has(url), 'the retained Blob still repairs persistent storage');
  cache.saved.set(url, new Response(source.bytes));
  await assert.rejects(readTerrainIndex(source, signal(), true), /Saved terrain index is missing/);
  assert.equal(await readTerrainIndex(source, signal()), index);
  assert.equal(await readTerrainIndex(source, signal(), true), index);
  assert.equal(parses(), 1); assert.equal(cache.requests(), 1);
});

test('canceling one caller during an index parse leaves the shared result available to other tiles', async t => {
  const source = await indexFixture('cancellation');
  storage(t, new Map([[source.shard.file, source.bytes]]));
  let release!: () => void, started!: () => void, parses = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const parsing = new Promise<void>(resolve => { started = resolve; });
  const text = Blob.prototype.text;
  t.mock.method(Blob.prototype, 'text', async function(this: Blob) { parses++; started(); await gate; return text.call(this); });
  t.after(release);
  const controller = new AbortController();
  const first = readTerrainIndex(source, controller.signal);
  await parsing;
  const second = readTerrainIndex(source, signal());
  controller.abort();
  await assert.rejects(first, { name: 'AbortError' });
  release();
  const index = await second;
  assert.equal(await readTerrainIndex(source, signal()), index); assert.equal(parses, 1);
  await assert.rejects(readTerrainIndex(source, controller.signal), { name: 'AbortError' });
});

test('canceling before archive storage opens never starts the DEM download and permits retry', async t => {
  const source = await indexFixture('cancel-before-archive');
  const cache = storage(t, new Map([[source.shard.file, source.bytes]]));
  const archive = JSON.parse(source.bytes.toString()).archives[0];
  const tile = { z: archive.zoom, x: archive.x, y: archive.y };
  const open = caches.open.bind(caches);
  let opened = 0, release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { started = resolve; });
  t.mock.method(caches, 'open', async (...args: Parameters<typeof open>) => {
    if (++opened === 2) { started(); await gate; }
    return open(...args);
  });
  t.after(release);
  const controller = new AbortController();
  const canceled = assert.rejects(readPackagedElevation(tile, source, controller.signal), { name: 'AbortError' });
  await waiting;
  controller.abort(); release(); await canceled;
  assert.equal(cache.requests(), 1, 'only the shared index was downloaded');
  assert.equal((await readPackagedElevation(tile, source, signal()))[0], Math.fround(123.5 / 0.3048));
  assert.equal(cache.requests(), 2, 'retry can reuse the index and fetch the DEM');
});

test('failed terrain fetches and parses can be retried, and cached validation remains specific to the shard', async t => {
  const source = await indexFixture('retry');
  storage(t, new Map([[source.shard.file, source.bytes]]));
  const fetch = globalThis.fetch;
  let fetches = 0, parses = 0;
  t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
    if (++fetches === 1) throw new TypeError('Temporary network failure');
    return fetch(...args);
  });
  await assert.rejects(readTerrainIndex(source, signal()), /Temporary network failure/);
  const text = Blob.prototype.text;
  t.mock.method(Blob.prototype, 'text', async function(this: Blob) {
    if (++parses === 1) throw new Error('Temporary Blob read failure');
    return text.call(this);
  });
  await assert.rejects(readTerrainIndex(source, signal()), /Temporary Blob read failure/);
  const index = await readTerrainIndex(source, signal());
  assert.equal(await readTerrainIndex(source, signal()), index); assert.equal(parses, 2);
  await assert.rejects(readTerrainIndex({ ...source, shard: { ...source.shard, x: source.shard.x + 64 } }, signal()),
    /Invalid terrain index/);
  assert.equal(await readTerrainIndex(source, signal()), index);
});

test('regional terrain preparation pins all native zooms; offline checks detect eviction and missing file membership', async t => {
  const cache = storage(t), source = { ...manifest, root: 'https://terrain.test/preparation' };
  const plan: DownloadPlan = { id: 'sample', regionId: 'sample', title: 'Sample', revision: '2026-09-03', terrain: true,
    bounds, files: [], references: [], catalog: { schemaVersion: 1, generatedAt: '2026-09-03T00:00:00Z',
      revision: '2026-09-03', charts: [], navigation: [], weather: [], terrain: source } };
  const prepared = await prepareRegionTerrain(plan, signal());
  assert.ok(isDownloadPlan(prepared));
  assert.equal(prepared.files.length, 26);
  assert.equal(new Set(prepared.files.map(f => f.url)).size, 26);
  assert.equal(terrainRegionKeys(bounds).size, 13);
  assert.ok(await terrainFilesIncluded(prepared));
  assert.equal(await terrainFilesIncluded({ ...prepared, files: prepared.files.slice(1) }), false);
  const shard = source.shards[0]!;
  const a = JSON.parse((await fixture(shard.file)).toString()).archives[0];
  await readPackagedElevation({ z: a.zoom, x: a.x, y: a.y }, { root: source.root, shard }, signal());
  const dataFile = prepared.files.find(file => file.url.includes(a.file))!;
  assert.equal(await cachedFileBytes(dataFile), a.byteLength);
  cache.offline();
  const reads = cache.requests();
  assert.ok(await terrainFilesIncluded(prepared));
  assert.equal(cache.requests(), reads, 'health checks never start network work');
  cache.saved.delete(terrainArchiveUrl(source.root, shard));
  assert.equal(await terrainFilesIncluded(prepared), false, 'a resident index cannot conceal eviction');
  assert.equal(cache.requests(), reads);
  await assert.rejects(regionTerrainFiles(bounds, { ...source, shards: source.shards.slice(1) }, location.href, signal()));
});

test('terrain files use the resumable queue, count toward completion and remain shared during removal', async () => {
  const file = { url: 'https://terrain.test/shared.dem', kind: 'terrain' as const, byteLength: 100, sha256: 'a'.repeat(64) };
  const first: DownloadPlan = { id: 'one', regionId: 'one', title: 'One', revision: '2026-09-03', files: [file], references: [] };
  const plans = new Map<string, DownloadPlan>(), cached = new Set<string>(); let transfers = 0, fail = true;
  const downloads = new RegionDownloads({ list: async () => [...plans.values()], save: async p => { plans.set(p.id, p); },
    forget: async id => { plans.delete(id); }, cachedBytes: async f => cached.has(f.url) ? f.byteLength : undefined,
    referencesReady: async () => true, prepare: async () => {},
    download: async f => { transfers++; if (fail) throw new Error('interrupted'); cached.add(f.url); },
    remove: async f => { cached.delete(f.url); }, exclusive: async work => work() });
  await downloads.start(first);
  assert.equal(downloads.snapshot()[0]!.state, 'error');
  fail = false; await downloads.start(first);
  assert.equal(downloads.snapshot()[0]!.state, 'complete');
  await downloads.start({ ...first, id: 'two', regionId: 'two' });
  assert.equal(transfers, 2);
  await downloads.remove('one'); assert.ok(cached.has(file.url));
  cached.clear(); await downloads.restore(); assert.equal(downloads.snapshot()[0]!.state, 'paused');
});

test('transient elevation fetches retry, permanent errors and cancellation do not', async t => {
  let count = 0;
  t.mock.method(globalThis, 'fetch', async () => { if (++count === 1) throw new TypeError('Failed to fetch'); return new Response('ok'); });
  assert.equal(await (await fetchElevation('https://terrain.test/tile', signal())).text(), 'ok');
  assert.equal(count, 2);
  t.mock.method(globalThis, 'fetch', async () => { count++; return new Response('', { status: 404 }); });
  await assert.rejects(fetchElevation('https://terrain.test/missing', signal()), /404/);
  assert.equal(count, 3);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fetchElevation('https://terrain.test/canceled', controller.signal), { name: 'AbortError' });
  assert.equal(count, 3);
});
