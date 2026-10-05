import assert from 'node:assert/strict';
import test from 'node:test';
import type { Bounds, GlideBlock } from '@zlayer/contracts';
import { project, unproject, type Segment } from '../src/core/geo/route-corridor';
import { createLandingOverview } from '../src/layers/glide/landing-overview';
import { createLandingHeatTiles, landingHeatMosaic, type LandingHeatTile } from '../src/layers/glide/landing-heat-tiles';
import type { LandingHeat } from '../src/layers/glide/landing-heat';
import { composeLandingHeatCells as composeLandingHeat } from '../src/layers/glide/landing-heat-composition';
import type { LandingManifest, LandingShard } from '../src/layers/glide/landing-data';
import type { LandingDisplayQuery } from '../src/layers/glide/landing-display';

const geographic = ([w, n, e, s]: Bounds): Bounds => {
  const a = unproject([w, n]), b = unproject([e, s]); return [a[0], b[1], b[0], a[1]];
};
function tile(z: number, x: number, y: number, value = 128, root = 'current') {
  const extent: Bounds = [x / 2 ** z, y / 2 ** z, (x + 1) / 2 ** z, (y + 1) / 2 ** z], bounds = geographic(extent);
  const block: GlideBlock = { key: `${z}/${x}/${y}`, kind: 'overview', bounds, rawBytes: 196608, bytes: 100,
    sha256: 'a'.repeat(64), records: 0, vertices: 0, rings: 0, tiers: [0, 0], schema: 0, tile: [z, x, y], offset: 16 };
  const shard: LandingShard = { id: block.key, file: `${root}/${block.key}`, sha256: 'a'.repeat(64), bytes: 100, rawBytes: 196608,
    bounds, count: 0, tiers: [0, 0], package: { root, block, archive: { file: 'archive.glo', bytes: 200, sha256: 'b'.repeat(64), bounds, kind: 'overview', blocks: [block] } } };
  const heat: LandingHeat = { density: true, extent, width: 1, height: 1, cells: Uint8Array.from([value, 0, 255]), flags: 0 };
  return { shard, heat };
}
const segments: Segment[] = [[project([-5, 0]), project([5, 0])]];
const manifest: LandingManifest = { schemaVersion: 8, builderVersion: 1, inputSha256: 'a'.repeat(64), generatedAt: '2026-10-03T00:00:00Z',
  status: 'experimental-candidates', geometryMeaning: 'generalized-candidate-area', coverage: [{ id: 'test', bounds: [-10, -1, 10, 1] }], shards: [] };
const request: LandingDisplayQuery = { id: 1, manifestUrl: 'https://example.test/glide', segments, discover: true, bounds: [-1, -.1, 0, .1], zoom: 9 };
const alpha = (tiles: LandingHeatTile[], lon: number, lat: number) => {
  const p = project([lon, lat]);
  for (const tile of tiles) {
    const [w, n, e, s] = tile.extent;
    if (p[0] < w || p[0] >= e || p[1] < n || p[1] >= s) continue;
    const image = tile.levels[0]!, x = Math.floor((p[0] - w) / (e - w) * image.width), y = Math.floor((p[1] - n) / (s - n) * image.height);
    if (image.rgba[(y * image.width + x) * 4 + 3]) return image.rgba[(y * image.width + x) * 4 + 3];
  }
  return 0;
};

test('resident mosaic preserves finer coverage and uses parents only outside resident children', () => {
  const parent = tile(10, 512, 512), child = tile(11, 1024, 1024, 0), fine = tile(12, 2048, 2048, 255);
  const other = tile(11, 1026, 1024, 64);
  const frame = { left: .5, top: .5, step: 1 / 4096, width: 6, height: 4 };
  const image = composeLandingHeat(landingHeatMosaic([parent, child, fine, other]), frame, segments);
  assert.equal(image.rgba[3], 224, 'fine candidate is not rounded away by its zero-density parent');
  assert.equal(image.rgba[7], 0, 'known empty child masks coarser parent density');
  assert.equal(image.rgba[11], Math.round(64 + 160 * Math.sqrt(128 / 255)), 'parent remains outside the child');
  assert.equal(image.rgba[19], Math.round(64 + 160 * Math.sqrt(64 / 255)), 'disjoint resident survives');
  assert.deepEqual(composeLandingHeat(landingHeatMosaic([other, fine, child, parent]), frame, segments), image);
  const saved = tile(11, 1024, 1024, 0, 'saved');
  assert.equal(landingHeatMosaic([parent, saved])[0]!.exclude, undefined, 'another release cannot mask a tile');
  saved.shard.package!.root = 'current'; saved.shard.scope = { include: [{ id: 'saved', bounds: [saved.shard.bounds] }], exclude: [] };
  assert.equal(landingHeatMosaic([parent, saved])[0]!.exclude, undefined, 'different ownership cannot mask a tile');
  parent.shard.scope = { exclude: saved.shard.scope.include! };
  parent.heat.scope = parent.shard.scope; saved.heat.scope = saved.shard.scope;
  const scoped = composeLandingHeat(landingHeatMosaic([parent, saved]), frame, segments);
  assert.equal(scoped.rgba[3], 0, 'coarse browsing coverage cannot fill an empty saved region');
  assert.ok(scoped.rgba[11], 'browsing coverage remains outside the saved region');
});

test('zoomed-out presentation includes every resident even when acquisition is limited to 32 blocks', async () => {
  const shards: LandingShard[] = Array.from({ length: 40 }, (_, i) => ({ id: String(i), file: String(i), sha256: 'a'.repeat(64), bytes: 100,
    rawBytes: 200, bounds: [-1 + i * .05, -.04, -.951 + i * .05, .04], count: 1, tiers: [0, 1] }));
  let reads = 0, inventories = 0;
  const worker = createLandingOverview(async (_url, shard) => {
    reads++; const a = project([shard.bounds[0], shard.bounds[3]]), b = project([shard.bounds[2], shard.bounds[1]]);
    return { extent: [...a, ...b], width: 1, height: 1, cells: Uint8Array.of(2), flags: 0 };
  }, async () => { inventories++; return { shards, limited: false }; });
  const signal = new AbortController().signal;
  for (const bounds of [[-1, -.1, 0, .1], [0, -.1, 1, .1]] as Bounds[]) {
    let result;
    do { result = await worker.query({ ...request, bounds }, manifest, signal); } while (result.more);
  }
  assert.equal(reads, 40); const before = inventories;
  const wide = { ...request, bounds: [-1.1, -.15, 1.1, .15] as Bounds, zoom: 6, discover: false };
  const result = await worker.query(wide, manifest, signal);
  assert.equal(reads, 40); assert.equal(inventories, before, 'overview reconciliation never discovers new metadata');
  assert.equal(result.more, false);
  for (const shard of shards) assert.ok(alpha(result.tiles, (shard.bounds[0] + shard.bounds[2]) / 2, 0), `resident ${shard.id}`);
  const limited = await worker.query({ ...wide, discover: true, zoom: 7 }, manifest, signal);
  assert.equal(limited.limited, true); assert.equal(limited.loadedFiles, 32); assert.equal(limited.totalFiles, 32);
  for (const shard of shards) assert.ok(alpha(limited.tiles, (shard.bounds[0] + shard.bounds[2]) / 2, 0));
});

test('zoom transitions keep resident fallback while new overview tiles load or fail, without double density', async () => {
  const coarse = tile(10, 512, 512, 128), fine = tile(11, 1024, 1024, 128);
  let fail = true, reads = 0;
  const worker = createLandingOverview(async (_url, shard) => {
    reads++;
    if (shard.file === coarse.shard.file && fail) throw Error('offline');
    return shard.file === coarse.shard.file ? coarse.heat : fine.heat;
  }, async (_manifest, _kind, _bounds, zoom) => ({ shards: [zoom === 10 ? coarse.shard : fine.shard], limited: false }));
  const signal = new AbortController().signal;
  const view = { ...request, bounds: fine.shard.bounds, zoom: 12 };
  const loaded = await worker.query(view, manifest, signal);
  const out = await worker.query({ ...view, zoom: 11 }, manifest, signal);
  assert.equal(out.incomplete, true); assert.ok(out.shadedCells, 'failed coarse acquisition preserves fine data');
  const sample = alpha(out.tiles, .02, -.02);
  fail = false; worker.retry();
  const recovered = await worker.query({ ...view, zoom: 11 }, manifest, signal);
  assert.equal(recovered.incomplete, false); assert.equal(alpha(recovered.tiles, .02, -.02), sample);
  assert.equal(recovered.tiles.find(tile => tile.key === loaded.tiles[0]!.key), loaded.tiles[0],
    'a new parent cannot recompose the resident child or its cached zoom levels');
  const warm = await worker.query({ ...view, zoom: 11 }, manifest, signal);
  assert.equal(warm.revision, recovered.revision); assert.equal(reads, 3);
  worker.reset();
  const empty = await worker.query({ ...view, discover: false }, manifest, signal);
  assert.equal(empty.shadedCells, 0, 'source replacement cannot expose old pixels');
  assert.notEqual(empty.revision, loaded.revision);
});

test('resident capacity is independent of drawing limits and cancellation preserves only completed inputs', async () => {
  const shards: LandingShard[] = Array.from({ length: 70 }, (_, i) => ({ id: String(i), file: String(i), sha256: 'a'.repeat(64), bytes: 100,
    rawBytes: 200, bounds: [-8.75 + i * .25, -.04, -8.55 + i * .25, .04], count: 1, tiers: [0, 1] }));
  let cancel = false;
  const controller = new AbortController();
  const worker = createLandingOverview(async (_url, shard) => {
    if (cancel) controller.abort();
    const a = project([shard.bounds[0], shard.bounds[3]]), b = project([shard.bounds[2], shard.bounds[1]]);
    return { extent: [...a, ...b], width: 1, height: 1, cells: Uint8Array.of(2), flags: 0 };
  }, async () => ({ shards, limited: false }));
  const wideRoute: Segment[] = [[project([-10, 0]), project([10, 0])]], signal = controller.signal;
  for (const shard of shards) await worker.query({ ...request, bounds: shard.bounds, segments: wideRoute }, manifest, signal);
  const wide = { ...request, bounds: [-9, -.1, 9, .1] as Bounds, zoom: 6, discover: false, segments: wideRoute };
  const result = await worker.query(wide, manifest, signal);
  const retained = shards.map(shard => !!alpha(result.tiles, (shard.bounds[0] + shard.bounds[2]) / 2, 0));
  assert.deepEqual(retained, shards.map((_, i) => i >= 6), 'only the 64 resident inputs draw; old inputs really evict');
  cancel = true;
  await assert.rejects(worker.query({ ...request, bounds: shards[0]!.bounds, segments: wideRoute }, manifest, signal), { name: 'AbortError' });
  const after = await worker.query(wide, manifest, new AbortController().signal);
  assert.deepEqual(after.tiles, result.tiles, 'aborted acquisition cannot replace resident pixels');
});

test('an unrelated leg edit retains a tile and its complete pyramid', () => {
  const west = tile(10, 500, 512), east = tile(10, 524, 512);
  const westLeg: Segment = [project([-5, -.05]), project([-3, -.05])];
  const eastLeg: Segment = [project([4, -.05]), project([5, -.05])];
  const cache = createLandingHeatTiles();
  const first = cache.prepare([west, east], [westLeg, eastLeg]);
  const next = cache.prepare([west, east], [westLeg, [project([4, -.1]), project([5, -.1])]]);
  const retained = first.find(tile => tile.extent[0] === west.heat.extent[0])!;
  assert.ok(retained);
  assert.equal(next.find(tile => tile.key === retained.key), retained);
  assert.notEqual(next.find(tile => tile.extent[0] === east.heat.extent[0])?.key,
    first.find(tile => tile.extent[0] === east.heat.extent[0])?.key);
});
