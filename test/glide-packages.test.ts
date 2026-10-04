import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { GLIDE_LIMITS, glideArtifactUrl, isGlideManifest, isGlideIndex, isGlideArchive, type GlideArchive,
  type GlideSource, type Bounds, type CatalogResponse } from '@zlayer/contracts';
import { cacheFixture } from './helpers/cache';
import { CHART_CACHE } from '../src/core/storage/cache-names';
import { decodeGlideDetail, decodeGlideOverview, readGlideBlock, readGlideIndex, readGlideArtifact } from '../src/layers/glide/landing-packages';
import { loadLandingManifest, loadLandingShard } from '../src/layers/glide/landing-loader';
import { landingShards, packagedLandingManifest } from '../src/layers/glide/landing-inventory';
import { prepareHeatScope } from '../src/layers/glide/landing-scope';
import { landingSources } from '../src/layers/glide/landing-sources';
import { createLandingDisplayWorker } from '../src/layers/glide/landing-display';
import { landingHeatImage } from '../src/layers/glide/landing-heat';
import { project, type Point } from '../src/core/geo/route-corridor';
import { prepareRegionGlide, glideFilesIncluded } from '../src/offline/glide';
import { RegionDownloads, type DownloadPlan } from '../src/offline/downloads';
import { cachedFileBytes } from '../src/offline/storage';
import { isDownloadPlan } from '../src/offline/plan-records';
import { createWorkspaceReadContext } from '../src/workspace/read-context';
import type { LandingShard, LandingManifest } from '../src/layers/glide/landing-data';
import type { GlideAreas } from '../src/layers/glide/types';

const fixtures = new URL('./fixtures/glide-delivery-v1/', import.meta.url);
const fixture = (file: string) => readFile(new URL(`charts/glide/${file}`, fixtures));
const root = JSON.parse((await fixture('manifest.json')).toString()) as GlideSource;
const expected = JSON.parse((await readFile(new URL('expected-detail.json', fixtures))).toString());
const signal = () => new AbortController().signal;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const source = (id: string): GlideSource => ({ ...root, root: `https://glide.test/${id}/glide` });
const catalog = (glide: GlideSource): CatalogResponse => ({ schemaVersion: 1, generatedAt: '2026-09-03T00:00:00Z',
  revision: '2026-09-03', charts: [], navigation: [], weather: [], glide });
const plan = (glide: GlideSource, i = 0): DownloadPlan => ({ id: `${glide.root}/${i}`, regionId: root.regions[i]!.id,
  title: 'Fixture', revision: '2026-09-03', bounds: root.regions[i]!.bounds, files: [], references: [], glide: true, catalog: catalog(glide) });
const part = (archive: GlideArchive, i = 0): LandingShard => {
  const block = archive.blocks[i]!;
  return { id: block.key, file: `${archive.file}#${block.key}`, sha256: block.sha256, bytes: block.bytes, rawBytes: block.rawBytes,
    bounds: block.bounds, count: block.records, tiers: block.tiers, package: { root: source('fixture').root, archive, block } };
};
const detailIndex = JSON.parse((await fixture(root.indexes.find(p => p.kind === 'detail')!.file)).toString());
const detail = detailIndex.archives[0] as GlideArchive;

function storage(t: test.TestContext) {
  const cache = cacheFixture(t, CHART_CACHE), requests: string[] = [];
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://glide.test/' } });
  t.after(() => descriptor ? Object.defineProperty(globalThis, 'location', descriptor) : Reflect.deleteProperty(globalThis, 'location'));
  let online = true;
  t.mock.method(globalThis, 'fetch', async (request: RequestInfo | URL) => {
    const url = new URL(request instanceof Request ? request.url : String(request)); requests.push(url.href);
    if (!online) throw new TypeError('offline');
    return new Response(await fixture(url.pathname.split('/glide/')[1]!));
  });
  return { ...cache, requests, offline() { online = false; } };
}
const ranges = (bounds: Bounds): GlideAreas => {
  const [w, s, e, n] = bounds;
  return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon',
    coordinates: [[[[w, s], [e, s], [e, n], [w, n], [w, s]]]] } }] };
};

test('publisher fixture decodes unchanged records, original IDs and polygon holes; overview never decodes polygons', async () => {
  assert.ok(isGlideManifest(root));
  for (const page of root.indexes) {
    const index: unknown = JSON.parse((await fixture(page.file)).toString());
    assert.ok(isGlideIndex(index, page));
    for (const archive of index.archives) {
      const bytes = await fixture(archive.file);
      assert.equal(sha(bytes), archive.sha256);
      for (const [i, block] of archive.blocks.entries()) {
        const raw = await readGlideBlock(new Blob([bytes]), archive, block, signal());
        if (block.kind === 'detail') {
          assert.deepEqual(JSON.parse(new TextDecoder().decode(raw)), expected);
          const areas = decodeGlideDetail(raw, part(archive, i));
          assert.deepEqual(areas.map(a => a.id), expected.indices.map((n: number) => `${expected.source}:${n}`));
          assert.equal(areas[0]!.polygon.length, 2);
          assert.equal(areas[1]!.widthFt, 60); assert.equal(areas[1]!.lengthFt, 600); assert.equal(areas[1]!.flags, 256);
          let x = 0, y = 0;
          const ring = expected.areas[0][1][0] as number[];
          for (let j = 0; j < ring.length; j += 2) {
            x += ring[j]!; y += ring[j + 1]!;
            assert.deepEqual(areas[0]!.polygon[0]![j / 2], project([x / 1e6, y / 1e6]));
          }
        } else {
          const heat = decodeGlideOverview(raw, block);
          assert.equal(heat.density, true); assert.equal(heat.cells.length, 196608);
        }
      }
    }
  }
  assert.equal(isGlideManifest({ ...root, limits: { ...root.limits, archiveBytes: 10e6 } }), false);
  assert.equal(isGlideManifest({ ...root, indexes: [...root.indexes, root.indexes[0]] }), false);
  assert.equal(isGlideManifest({ ...root, coverage: { ...root.coverage, file: '../outside.json' } }), false);
  const bad = { ...detail, blocks: [{ ...detail.blocks[0], offset: detail.blocks[0]!.offset + 1 }] };
  assert.equal(isGlideArchive(bad), false);
});

test('archive reader rejects wrong headers, directory identities, corruption and oversized inflation', async () => {
  const bytes = await fixture(detail.file), block = detail.blocks[0]!;
  for (const offset of [0, 8, 12, bytes.length - 3]) {
    const bad = new Uint8Array(bytes); bad[offset]! ^= 1;
    await assert.rejects(readGlideBlock(new Blob([bad]), detail, block, signal()));
  }
  await assert.rejects(readGlideBlock(new Blob([bytes]), detail, { ...block, sha256: '0'.repeat(64) }, signal()));
  const compressed = gzipSync(new Uint8Array(2048)), entry = { ...block, rawBytes: 1, bytes: compressed.length, sha256: sha(compressed), offset: 0 };
  const directory = Buffer.from(JSON.stringify([entry])), header = Buffer.alloc(16); header.write('GLIDEP01'); header.writeUInt32LE(directory.length, 8);
  const oversized = Buffer.concat([header, directory, compressed]);
  const archive = { ...detail, bytes: oversized.length, blocks: [{ ...entry, offset: 16 + directory.length }] };
  await assert.rejects(readGlideBlock(new Blob([oversized]), archive, archive.blocks[0]!, signal()), /exceeds/);
  const invalidDensity = new Uint8Array(256 * 256 * 3); invalidDensity[0] = 255;
  const overview = JSON.parse((await fixture(root.indexes.find(p => p.kind === 'overview')!.file)).toString()).archives[0].blocks[0];
  assert.throws(() => decodeGlideOverview(invalidDensity, overview), /density/);
  assert.equal(isGlideArchive({ ...detail, blocks: [{ ...block, oversized: true, records: 2 }] }), false);
  assert.equal(GLIDE_LIMITS.oversizedBlockRawBytes, 8 * 1024 * 1024);
});

test('route browsing reads only numeric overview; ranges acquire detail and preserve original inspection IDs', async t => {
  const cache = storage(t), glide = source('display'), worker = createLandingDisplayWorker();
  const request = { id: 1, manifestUrl: `${glide.root}/manifest.json`, sources: { packages: [{ source: glide, scope: { exclude: [] } }] },
    bounds: [-120.01, 34.99, -119.99, 35.01] as Bounds, zoom: 12, discover: true,
    segments: [[project([-120.03, 35]), project([-119.97, 35])]] as [Point, Point][], ranges: { type: 'FeatureCollection' as const, features: [] } };
  let result = await worker.query(request);
  for (let i = 0; result.more && i < 10; i++) result = await worker.query(request);
  assert.ok(result.heat?.shadedCells);
  assert.equal(cache.requests.some(url => url.includes('.gld')), false, 'route views do not acquire detail');
  const fetched = cache.requests.length;
  const warm = await worker.query({ ...request, renderedKey: result.renderKey });
  assert.equal(warm.heat, undefined); assert.equal(cache.requests.length, fetched);
  const detailed = await worker.query({ ...request, ranges: ranges(request.bounds) });
  assert.ok(detailed.collection!.features.length); assert.ok(cache.requests.some(url => url.includes('.gld')));
  assert.equal((await worker.inspect([-120.001, 35]))?.id, `${expected.source}:0`);
  assert.equal((await worker.inspect([-119.999, 35]))?.id, `${expected.source}:1`, 'preferred hole retains best-effort identity');
});

test('numeric density fractions affect opacity and scopes choose the pinned edition independently of cache health', () => {
  const cells = new Uint8Array(256 * 256 * 3);
  for (let i = 0; i < cells.length; i += 3) { cells[i] = 16; cells[i + 2] = 255; }
  const heat = { density: true, extent: [0, 0, 1, 1] as Bounds, width: 256, height: 256, cells, flags: 0 };
  const bounds: Bounds = [-.1, -.1, .1, .1], route: [Point, Point][] = [[project([-1, 0]), project([1, 0])]];
  const image = landingHeatImage([heat], bounds, 10, route);
  assert.ok(image.shadedCells > 0);
  assert.equal(Math.max(...image.rgba.filter((_, i) => i % 4 === 3)), Math.round(64 + 160 * Math.sqrt(16 / 255)));
  const old = source('saved'), current = source('latest'), saved = plan(old);
  const context = createWorkspaceReadContext(catalog(current), [{ plan: saved, catalog: saved.catalog!, bounds: saved.bounds!, key: 'saved', unavailable: true }]);
  const sources = landingSources(context, 'https://glide.test/')!;
  assert.equal(sources.packages[0]!.source.root, old.root);
  const point = project([-120.05, 35]);
  assert.equal(prepareHeatScope(sources.packages[0]!.scope)!(...point), true);
  assert.equal(prepareHeatScope(sources.packages[1]!.scope)!(...point), false);
});

test('regional preparation includes all zooms and shared dependencies; cache-only readiness detects omitted or evicted metadata', async t => {
  const cache = storage(t), glide = source('offline');
  const prepared = await prepareRegionGlide(plan(glide), signal());
  assert.ok(isDownloadPlan(prepared));
  const archives = prepared.files.filter(f => /\.(gld|glo)\?/.test(f.url));
  assert.equal(archives.length, 12);
  assert.equal(cache.requests.some(url => /\.(gld|glo)\?/.test(url)), false, 'preparation reads only metadata');
  for (const file of prepared.files) {
    const artifact = { file: new URL(file.url).pathname.split('/glide/')[1]!, bytes: file.byteLength!, sha256: file.sha256! };
    await readGlideArtifact(glide.root, artifact, signal());
    assert.equal(await cachedFileBytes(file), file.byteLength);
  }
  const other = await prepareRegionGlide(plan(glide, 1), signal());
  assert.ok(other.files.some(file => archives.some(shared => shared.url === file.url)));
  cache.offline(); const requests = cache.requests.length;
  assert.equal(await glideFilesIncluded(prepared, signal()), true);
  assert.equal(await glideFilesIncluded({ ...prepared, files: prepared.files.filter(f => f.url !== archives[0]!.url) }, signal()), false);
  const page = root.indexes[0]!, url = glideArtifactUrl(glide.root, page);
  // Warm parsed index still must check its persistent receipt.
  await readGlideIndex(glide.root, page, signal(), true); cache.stored.delete(url);
  assert.equal(await glideFilesIncluded(prepared, signal()), false);
  assert.equal(cache.requests.length, requests);
  const legacy = { ...prepared }; delete legacy.glide;
  assert.equal(await prepareRegionGlide(legacy, signal()), legacy);
  assert.equal(await glideFilesIncluded(legacy, signal()), true);
});

test('offline readers use region-local indexes, and region removal retains shared and previous glide files', async t => {
  const cache = storage(t), glide = source('local-index'), prepared = await prepareRegionGlide(plan(glide), signal());
  for (const file of prepared.files) await readGlideArtifact(glide.root, {
    file: new URL(file.url).pathname.split('/glide/')[1]!, bytes: file.byteLength!, sha256: file.sha256!,
  }, signal());
  // The national page can differ from the region's immutable local page.
  const remote = { ...glide, indexes: glide.indexes.map(page => ({ ...page, file: `indexes/${'a'.repeat(64)}.json`, sha256: 'a'.repeat(64) })) };
  const saved = { ...prepared, catalog: catalog(remote) };
  const context = createWorkspaceReadContext(catalog(source('new-release')), [{ plan: saved, catalog: saved.catalog, bounds: saved.bounds!, key: 'saved' }]);
  const sources = landingSources(context, 'https://glide.test/')!;
  cache.offline(); const requests = cache.requests.length;
  const manifest = await loadLandingManifest(`${glide.root}/manifest.json`, signal(), { packages: [sources.packages[0]!] });
  const selected = await landingShards(manifest, 'detail', saved.bounds![0]!, 0, signal());
  assert.equal(selected.shards.length, 1); assert.equal(cache.requests.length, requests);
  const shared = prepared.files.find(file => file.url.includes('.gld'))!;
  const exclusive = prepared.files.find(file => file.url.includes('/regions/'))!;
  const other = { ...prepared, id: 'other', files: [shared], previous: { ...prepared, id: 'previous', files: [exclusive] } };
  const removed: string[] = [];
  const downloads = new RegionDownloads({ list: async () => [prepared, other], save: async () => {}, forget: async () => {},
    cachedBytes: async file => file.byteLength, prepare: async () => {}, download: async () => {},
    remove: async file => { removed.push(file.url); }, referencesReady: async () => true, exclusive: work => work() });
  await downloads.restore(); await downloads.remove(prepared.id);
  assert.ok(!removed.includes(shared.url)); assert.ok(!removed.includes(exclusive.url));
});

test('saved glide ownership uses the chart state boundary, not overlapping download envelopes', () => {
  const california = { id: 'us-CA', bounds: [[-124.41, 32.53, -114.13, 42.01] as Bounds] };
  const include = prepareHeatScope({ include: [california], exclude: [] })!;
  const outside = prepareHeatScope({ exclude: [california] })!;
  assert.equal(include(...project([-118.2437, 34.0522])), true);
  assert.equal(include(...project([-115.14, 36.17])), false, 'Las Vegas is inside the CA download envelope but belongs to NV');
  assert.equal(outside(...project([-115.14, 36.17])), true);
  assert.equal(outside(...project([-118.2437, 34.0522])), false);
});

test('overlapping saved regions of one release share a root and deduplicate common detail blocks', async t => {
  storage(t); const glide = source('dedup'), west = plan(glide), east = plan(glide, 1);
  const context = createWorkspaceReadContext(catalog(source('browsing')), [west, east].map((plan, i) =>
    ({ plan, catalog: plan.catalog!, bounds: plan.bounds!, key: String(i) })));
  const sources = landingSources(context, 'https://glide.test/')!;
  assert.equal(sources.packages[0]!.regions!.length, 2);
  const manifest = await loadLandingManifest(`${glide.root}/manifest.json`, signal(), { packages: [sources.packages[0]!] });
  const result = await landingShards(manifest, 'detail', [-120.1, 34.9, -119.9, 35.1], 0, signal());
  assert.equal(result.shards.length, 1);
  assert.equal(await landingShards(manifest, 'detail', [-120.1, 34.9, -119.9, 35.1], 0, signal()), result, 'progressive queries reuse spatial metadata');
});

test('a missing neighboring edition keeps saved regional detail visible and does not borrow it across ownership', async t => {
  const cache = storage(t), saved = source('saved-partial'), prepared = await prepareRegionGlide(plan(saved), signal());
  for (const file of prepared.files) await readGlideArtifact(saved.root, {
    file: new URL(file.url).pathname.split('/glide/')[1]!, bytes: file.byteLength!, sha256: file.sha256!,
  }, signal());
  const context = createWorkspaceReadContext(catalog(source('absent-neighbor')), [
    { plan: prepared, catalog: prepared.catalog!, bounds: prepared.bounds!, key: 'saved' },
  ]);
  cache.offline();
  const worker = createLandingDisplayWorker(), bounds: Bounds = [-120.01, 34.99, -119.99, 35.01];
  const request = { id: 1, manifestUrl: `${saved.root}/manifest.json`, sources: landingSources(context, 'https://glide.test/')!,
    bounds, zoom: 12, discover: true, segments: [[project([-120.03, 35]), project([-119.97, 35])]] as [Point, Point][], ranges: ranges(bounds) };
  let result = await worker.query(request);
  for (let i = 0; result.more && i < 10; i++) result = await worker.query(request);
  assert.equal(result.status.state, 'partial'); assert.ok(result.collection?.features.length);
  assert.equal((await worker.inspect([-120.001, 35]))?.id, `${expected.source}:0`);
  assert.equal((await worker.inspect([-119.995, 35])), null);
});


test('a legacy shard retains its schema alongside a saved package from a different record schema', async t => {
  storage(t);
  const records = structuredClone(expected.areas);
  for (const record of records) record[0].push(12, -5);
  const raw = Buffer.from(JSON.stringify(records)), bytes = gzipSync(raw), digest = sha(bytes);
  const shard: LandingShard = { ...part(detail), id: 'legacy', file: `${digest}.glide.gz`, sha256: digest,
    bytes: bytes.length, rawBytes: raw.length };
  delete shard.package;
  const legacy: LandingManifest = { schemaVersion: 9, builderVersion: 1, generatedAt: root.generatedAt,
    inputSha256: 'c'.repeat(64), status: 'experimental-candidates', geometryMeaning: 'generalized-candidate-area',
    coverage: [{ id: 'legacy', bounds: shard.bounds }], shards: [shard] };
  const mixed = await packagedLandingManifest({ packages: [{ source: source('schema-eight'), scope: { exclude: [] } }],
    legacyScope: { exclude: [] } }, legacy, signal());
  assert.equal(mixed.schemaVersion, 8); assert.equal(mixed.shards[0]!.recordSchema, 9);
  t.mock.method(globalThis, 'fetch', async () => new Response(bytes));
  const areas = await loadLandingShard('https://glide.test/legacy/manifest.json', mixed.shards[0]!, signal(), mixed.schemaVersion);
  assert.equal(areas[0]!.alongGradePercent, 1.2); assert.equal(areas[0]!.crossGradePercent, -.5);
});
