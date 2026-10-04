import assert from 'node:assert/strict';
import test from 'node:test';
import type { Bounds } from '@zlayer/contracts';
import { project, type Point, type Segment } from '../src/core/geo/route-corridor';
import { decodeLandingHeat, encodeLandingHeat, landingHeatFrame, landingHeatImage, type LandingHeat } from '../src/layers/glide/landing-heat';
import { createLandingDisplayWorker, type LandingDisplayQuery } from '../src/layers/glide/landing-display';
import type { LandingArea, LandingManifest, LandingShard } from '../src/layers/glide/landing-data';
import { emptyAreas, type GlideAreas } from '../src/layers/glide/types';
import { inRouteCorridor } from '../src/layers/glide/coverage';
const box: Bounds = [-.2, -.05, .2, .05];
const rect = ([w, s, e, n]: Bounds): Point[] => [[w, s], [e, s], [e, n], [w, n], [w, s]];
const parts: LandingShard[] = ['a', 'b', 'c'].map(id => ({ id, file: `${id.repeat(64)}.glide.gz`, sha256: id.repeat(64), bytes: 100,
  rawBytes: 200, bounds: box, count: 1, tiers: [0, 1] }));
const manifest = (shards = parts): LandingManifest => ({ schemaVersion: 8, builderVersion: 1, inputSha256: 'd'.repeat(64),
  generatedAt: '2026-10-03T00:00:00Z', status: 'experimental-candidates', geometryMeaning: 'generalized-candidate-area',
  coverage: [{ id: 'sample', bounds: [-2, -2, 2, 2] }], shards });
const segments: Segment[] = [[project([-1, 0]), project([1, 0])]];
const heat = (bounds = box, tier = 2): LandingHeat => {
  const a = project([bounds[0], bounds[3]]), b = project([bounds[2], bounds[1]]);
  return { extent: [a[0], a[1], b[0], b[1]], width: 16, height: 16, cells: new Uint8Array(256).fill(tier), flags: 1 };
};
const ranges = (bounds: Bounds): GlideAreas => ({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {},
  geometry: { type: 'MultiPolygon', coordinates: [[rect(bounds)]] } }] });
const area: LandingArea = { id: 'area', tier: 2, flags: 1, polygon: [rect(box).map(project)],
  start: [-.1, 0], end: [.1, 0], widthFt: 200, lengthFt: 3000, elevationM: 50 };
const request = (patch: Partial<LandingDisplayQuery> = {}): LandingDisplayQuery => ({ id: 1, manifestUrl: 'https://example.test/glide/manifest.json',
  bounds: [-.5, -.1, .5, .1], zoom: 9, discover: true, segments, ranges: emptyAreas(), ...patch });

test('density cache validates dimensions and cell values; zoom changes its bounded screen resolution', () => {
  const grid = heat();
  assert.deepEqual(decodeLandingHeat(encodeLandingHeat(grid)), grid);
  const bad = encodeLandingHeat(grid); new Uint8Array(bad)[48] = 3;
  assert.throws(() => decodeLandingHeat(bad));
  assert.throws(() => decodeLandingHeat(bad.slice(0, 30)));
  const coarse = landingHeatFrame(box, 8), fine = landingHeatFrame(box, 11);
  assert.ok(fine.step < coarse.step);
  assert.ok(fine.width <= 385 && fine.height <= 385);
});

test('density uses union coverage, preserves empty holes, and clips to the route corridor', () => {
  const grid = heat(), single = landingHeatImage([grid], box, 10, segments);
  assert.ok(single.shadedCells > 0);
  assert.deepEqual(landingHeatImage([grid, grid], box, 10, segments), single, 'overlap must not inflate density');
  assert.equal(landingHeatImage([grid], box, 10, []).shadedCells, 0);
  assert.equal(landingHeatImage([heat([-.2, 1, .2, 1.1])], [-.2, 1, .2, 1.1], 10, segments).shadedCells, 0);
  grid.cells.fill(0);
  assert.equal(landingHeatImage([grid], box, 10, segments).shadedCells, 0);
  const wrapped = heat([179.8, -.05, 179.9, .05]);
  assert.ok(landingHeatImage([wrapped], [-180.3, -.1, -180, .1], 10,
    [[project([-180.4, 0]), project([-179.5, 0])]]).shadedCells > 0);
});

test('density matches independent point sampling across mixed grids, holes, overlaps and world copies', () => {
  for (const [longitude, latitude] of [[0, 0], [179.9, 65], [-180.1, -65]] as Point[]) {
    const bounds: Bounds = [longitude - .25, latitude - .2, longitude + .25, latitude + .2];
    const route: Segment[] = [[project([longitude - .3, latitude - .1]), project([longitude + .3, latitude + .1])]];
    const grids = Array.from({ length: 6 }, (_, i) => {
      const grid = heat([longitude - .3 + i * .07, latitude - .15, longitude - .15 + i * .07, latitude + .15]);
      grid.cells = Uint8Array.from(grid.cells, (_, j) => (j + Math.floor(j / grid.width) + i) % 3);
      return grid;
    });
    // The same ground in another longitude copy must not inflate its density.
    grids.push({ ...grids[0]!, extent: grids[0]!.extent.map((v, i) => i % 2 ? v : v + 1) as Bounds });
    const image = landingHeatImage(grids, bounds, 8, route), { left, top, width, height, step } = landingHeatFrame(bounds, 8);
    const expected = new Uint8ClampedArray(width * height * 4), center = left + width * step / 2;
    let shaded = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const x0 = left + x * step, y0 = top + y * step;
      if (![[x0, y0], [x0 + step, y0], [x0 + step, y0 + step], [x0, y0 + step]]
        .every(point => inRouteCorridor(point as Point, route))) continue;
      const samples: number[] = [];
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const wx = x0 + (sx + .5) / 4 * step, wy = y0 + (sy + .5) / 4 * step;
        samples.push(Math.max(0, ...grids.map(grid => {
          const [w, n, e, s] = grid.extent, shift = Math.round(center - (w + e) / 2);
          const px = Math.floor((wx - shift - w) / (e - w) * grid.width), py = Math.floor((wy - n) / (s - n) * grid.height);
          return px >= 0 && px < grid.width && py >= 0 && py < grid.height ? grid.cells[py * grid.width + px]! : 0;
        })));
      }
      const covered = samples.filter(tier => tier > 0).length, preferred = samples.filter(tier => tier === 2).length;
      if (!covered) continue;
      expected.set([...(preferred > covered / 2 ? [83, 229, 45] : [162, 59, 255]),
        Math.round(64 + 160 * Math.sqrt(covered / 16))], (y * width + x) * 4);
      shaded++;
    }
    assert.ok(shaded > 0);
    assert.deepEqual(image.rgba, expected); assert.equal(image.shadedCells, shaded);
    assert.deepEqual(landingHeatImage([...grids].reverse(), bounds, 8, route).rgba, expected, 'source order cannot change tier dominance');
  }
});

test('route overview acquires two summaries concurrently, publishes progress, and never requests detailed geometry', async () => {
  let active = 0, maximum = 0, reads = 0, details = 0;
  const worker = createLandingDisplayWorker(async () => manifest(), async () => {
    reads++; active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 5)); active--; return heat();
  }, async () => { details++; return [area]; });
  const first = await worker.query(request());
  assert.equal(maximum, 2); assert.equal(reads, 2); assert.equal(details, 0);
  assert.equal(first.more, true); assert.equal(first.status.state, 'loading'); assert.ok(first.heat?.shadedCells);
  assert.equal(first.collection?.features.length, 0);
  const done = await worker.query(request({ renderedKey: first.renderKey }));
  assert.equal(reads, 3); assert.equal(done.more, false); assert.equal(done.status.state, 'ready');
  const warm = await worker.query(request({ renderedKey: done.renderKey }));
  assert.equal(reads, 3); assert.equal(details, 0); assert.equal(warm.heat, undefined); assert.equal(warm.collection, undefined);
  const zoom = await worker.query(request({ bounds: [-.1, -.04, .1, .04], zoom: 12, renderedKey: done.renderKey }));
  assert.equal(reads, 3); assert.ok(zoom.heat); assert.equal(details, 0);
});

test('ownship/selected ranges admit and clip polygons without a route and clear them when the range is lost', async () => {
  let summaries = 0, details = 0;
  const worker = createLandingDisplayWorker(async () => manifest([parts[0]!]), async () => { summaries++; return heat(); }, async () => { details++; return [area]; });
  const first = await worker.query(request({ segments: [], ranges: ranges([-.04, -.04, .04, .04]) }));
  assert.equal(first.status.state, 'ready'); assert.equal(first.status.detail, true); assert.equal(summaries, 0); assert.equal(details, 1);
  assert.equal(first.collection?.features.length, 1);
  assert.equal(worker.inspect([0, 0])?.id, 'area'); assert.equal(worker.inspect([.15, 0]), null);
  for (const point of first.collection!.features[0]!.geometry.coordinates.flat(2)) assert.ok(Math.abs(point[0]!) <= .0400001);
  const removed = await worker.query(request({ segments: [], renderedKey: first.renderKey }));
  assert.equal(removed.status.state, 'route'); assert.equal(removed.collection?.features.length, 0); assert.equal(worker.inspect([0, 0]), null);
});

test('failed files and unprepared regions remain incomplete; retry refreshes summaries', async () => {
  let unavailable = true, reads = 0;
  const worker = createLandingDisplayWorker(async () => manifest([parts[0]!]), async () => {
    reads++; if (unavailable) throw new Error('offline'); return heat();
  }, async () => [area]);
  const failed = await worker.query(request()); assert.equal(failed.status.state, 'partial'); assert.equal(failed.more, false);
  await worker.query(request()); assert.equal(reads, 1, 'failed files do not spin');
  unavailable = false;
  assert.equal((await worker.query(request({ revalidate: true }))).status.state, 'ready'); assert.equal(reads, 2);
  const outside = await worker.query(request({ bounds: [-.5, 4, .5, 4.1], segments: [[project([-1, 4]), project([1, 4])]] }));
  assert.equal(outside.status.state, 'outside');
});

test('cancellation prevents old summary publication and source identity changes invalidate the local grids', async () => {
  let finish: (() => void) | undefined, reads = 0, changed = false;
  const worker = createLandingDisplayWorker(async () => ({ ...manifest([parts[0]!]), inputSha256: (changed ? 'e' : 'd').repeat(64) }), async () => {
    reads++; if (reads === 1) await new Promise<void>(resolve => { finish = resolve; }); return heat();
  }, async () => [area]);
  const pending = worker.query(request());
  while (!finish) await new Promise(resolve => setTimeout(resolve, 0));
  worker.cancel(1); finish(); await assert.rejects(pending);
  await worker.query(request()); assert.equal(reads, 2);
  changed = true; await worker.query(request({ revalidate: true })); assert.equal(reads, 3);
});

test('detail adopts a manifest refreshed during route-only browsing, even with unchanged preparation time and input digest', async () => {
  let current = manifest([parts[0]!]);
  const reads: string[] = [];
  const worker = createLandingDisplayWorker(async () => current, async () => heat(), async (_url, shard) => {
    reads.push(shard.id); return [{ ...area, id: shard.id }];
  });
  const first = await worker.query(request({ ranges: ranges(box) }));
  assert.equal(worker.inspect([0, 0])?.id, 'a');
  assert.equal(worker.inspect([0, 0])?.sourceKey, first.status.sourceKey);
  current = manifest([parts[1]!]);
  const overview = await worker.query(request({ revalidate: true, renderedKey: first.renderKey }));
  assert.equal(worker.inspect([0, 0]), null);
  assert.notEqual(overview.status.sourceKey, first.status.sourceKey);
  const restored = await worker.query(request({ ranges: ranges(box), renderedKey: overview.renderKey }));
  assert.deepEqual(reads, ['a', 'b']);
  assert.equal(worker.inspect([0, 0])?.id, 'b');
  assert.equal(worker.inspect([0, 0])?.sourceKey, restored.status.sourceKey);
  assert.equal(restored.status.sourceKey, overview.status.sourceKey);
  const warm = await worker.query(request({ ranges: ranges(box), renderedKey: restored.renderKey }));
  assert.equal(warm.collection, undefined); assert.deepEqual(reads, ['a', 'b']);
});

test('a cancelled refresh still synchronizes the accepted manifest before detail resumes', async () => {
  let current = manifest([parts[0]!]), hold = false;
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const worker = createLandingDisplayWorker(async () => current, async () => {
    if (hold) { entered(); await gate; }
    return heat();
  }, async (_url, shard) => [{ ...area, id: shard.id }]);
  const first = await worker.query(request({ ranges: ranges(box) }));
  current = manifest([parts[1]!]); hold = true;
  const pending = worker.query(request({ id: 2, ranges: ranges(box), revalidate: true }));
  await started; worker.cancel(2); finish(); await assert.rejects(pending, { name: 'AbortError' });
  const resumed = await worker.query(request({ id: 3, ranges: ranges(box), renderedKey: first.renderKey }));
  assert.equal(worker.inspect([0, 0])?.id, 'b');
  assert.notEqual(resumed.status.sourceKey, first.status.sourceKey);
  assert.equal(worker.inspect([0, 0])?.sourceKey, resumed.status.sourceKey);
});


test('overview discovery and preparation coverage follow both sides of the date line', async () => {
  const boxes: Bounds[] = [[179.8, -.05, 179.9, .05], [-179.9, -.05, -179.8, .05]];
  const shards = boxes.map((bounds, i) => ({ ...parts[i]!, bounds }));
  let reads = 0;
  const worker = createLandingDisplayWorker(async () => ({ ...manifest(shards), coverage: [{ id: 'world', bounds: [-180, -2, 180, 2] }] }),
    async (_url, shard) => { reads++; return heat(shard.bounds); }, async () => { throw new Error('No overview detail'); });
  for (const bounds of [[179.5, -.1, -179.5, .1], [-180.5, -.1, -179.5, .1]] as Bounds[]) {
    const result = await worker.query(request({ bounds, segments: [[project([179, 0]), project([181, 0])]] }));
    assert.equal(result.status.state, 'ready'); assert.equal(result.status.loadedFiles, 2); assert.ok(result.heat?.shadedCells);
  }
  assert.equal(reads, 2);
});
