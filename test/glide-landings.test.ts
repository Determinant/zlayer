import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { Bounds } from '@zlayer/contracts';
import { JsonResponseError } from '../src/core/data/errors';
import { project, type Point, type Segment } from '../src/core/geo/route-corridor';
import { decodeLandingAreas, isLandingManifest, type LandingManifest, type LandingShard } from '../src/layers/glide/landing-data';
import { createLandingWorker, type LandingQuery } from '../src/layers/glide/landing-planner';
import { loadLandingShard } from '../src/layers/glide/landing-loader';
import { glidePreferences } from '../src/layers/glide/preferences';

const rect = ([w, s, e, n]: Bounds): Point[] => [[w, s], [e, s], [e, n], [w, n]];
function encode(ring: Point[]): number[] {
  let x = 0, y = 0;
  return ring.flatMap(point => {
    const nx = Math.round(point[0] * 1e6), ny = Math.round(point[1] * 1e6), delta = [nx - x, ny - y];
    x = nx; y = ny; return delta;
  });
}
const record = (box: Bounds, tier = 2, holes: Bounds[] = [], flags = 0) => [
  [Math.round(box[0] * 1e6), 0, Math.round(box[2] * 1e6), 0, 200, tier === 2 ? 3000 : 1500, 50, tier],
  [box, ...holes].map(box => encode(rect(box))), flags,
];
function shard(id: string, box: Bounds, records: unknown[]): LandingShard {
  const raw = JSON.stringify(records) + '\n', zip = gzipSync(raw), sha256 = createHash('sha256').update(zip).digest('hex');
  return { id, file: `${sha256}.glide.gz`, sha256, bounds: box, bytes: zip.length, rawBytes: Buffer.byteLength(raw),
    count: records.length, tiers: [records.filter((row: any) => row[0][7] === 1).length, records.filter((row: any) => row[0][7] === 2).length] };
}
const manifest = (shards: LandingShard[]): LandingManifest => ({ schemaVersion: 4, builderVersion: 9,
  generatedAt: '2026-10-02T00:00:00Z', inputSha256: 'a'.repeat(64), status: 'experimental-candidates',
  geometryMeaning: 'generalized-candidate-area', coverage: [{ id: 'sample', bounds: [-2, -2, 2, 2] }], shards });
const segments: Segment[] = [[project([-1, 0]), project([1, 0])]];
const request = (patch: Partial<LandingQuery> = {}): LandingQuery => ({ id: 1, manifestUrl: 'https://example.test/glide/manifest.json',
  bounds: [-.5, -.1, .5, .1], segments, discover: true, ...patch });

test('landing manifest and rings reject incompatible/unsafe data while preserving publisher holes', () => {
  const records = [record([-.2, -.05, .2, .05], 2, [[-.05, -.02, .05, .02]], 1)];
  const part = shard('one', [-.2, -.05, .2, .05], records), doc = manifest([part]);
  assert.ok(isLandingManifest(doc));
  for (const change of [{ schemaVersion: 3 }, { geometryMeaning: 'runway' }, { shards: [{ ...part, file: '../outside.gz' }] },
    { shards: [{ ...part, rawBytes: 17 * 1024 * 1024 }] }, { shards: [{ ...part, count: 2 }] }]) {
    assert.equal(isLandingManifest({ ...doc, ...change }), false);
  }
  const [area] = decodeLandingAreas(records, part);
  assert.equal(area!.polygon.length, 2); assert.equal(area!.polygon[0]!.length, 5);
  assert.deepEqual(area!.polygon[0]![0], project([-.2, -.05]));
  assert.equal(area!.flags, 1);
  assert.throws(() => decodeLandingAreas(records, { ...part, bounds: [0, 0, .1, .1] }));
  assert.throws(() => decodeLandingAreas([record([-.2, -.05, .2, .05], 2, [], 2)], part));
  for (const flags of [2, 3, 6, 7, 14, 15]) {
    const rows = [record([-.2, -.05, .2, .05], 1, [], flags)];
    const source = shard('scrub', [-.2, -.05, .2, .05], rows);
    assert.equal(decodeLandingAreas(rows, source)[0]!.flags, flags);
  }
  for (const flags of [4, 5, 8, 9, 10, 11, 12, 13, 16]) {
    const rows = [record([-.2, -.05, .2, .05], 1, [], flags)];
    assert.throws(() => decodeLandingAreas(rows, shard('invalid', [-.2, -.05, .2, .05], rows)));
  }
  assert.equal(glidePreferences.select({}).glideLandingsEnabled, false);
  assert.equal(glidePreferences.select({ glideLandingsEnabled: true }).glideLandingsEnabled, true);
});

test('worker merges shard edges, retains holes/flags and reuses geometry and decoded files across pan and zoom', async () => {
  const rows = [[record([-.2, -.05, .1, .05], 2, [[-.1, -.02, -.05, .02]], 1)], [record([.1, -.05, .3, .05])]];
  const parts = [shard('a', [-.2, -.05, .1, .05], rows[0]!), shard('b', [.1, -.05, .3, .05], rows[1]!)];
  let reads = 0;
  const worker = createLandingWorker(async () => manifest(parts), async (_url, part) => {
    reads++; return decodeLandingAreas(rows[parts.indexOf(part)]!, part);
  });
  const cold = await worker.query(request());
  assert.equal(reads, 2); assert.equal(cold.status.state, 'ready'); assert.equal(cold.status.cultivated, true);
  assert.equal(cold.collection!.features.length, 1);
  assert.equal(cold.collection!.features[0]!.geometry.coordinates.length, 1, 'touching shards share a perimeter');
  assert.equal(cold.collection!.features[0]!.geometry.coordinates[0]!.length, 2, 'important hole survives');
  const pan = await worker.query(request({ bounds: [.15, -.1, .35, .1], renderedKey: cold.renderKey }));
  assert.equal(pan.collection, undefined); assert.equal(pan.renderKey, cold.renderKey); assert.equal(reads, 2);
  const zoom = await worker.query(request({ discover: false, renderedKey: cold.renderKey }));
  assert.equal(zoom.collection, undefined); assert.equal(zoom.status.state, 'zoom'); assert.equal(reads, 2);
  const returned = await worker.query(request({ bounds: [359.5, -.1, 360.5, .1], renderedKey: cold.renderKey }));
  assert.equal(returned.status.state, 'ready'); assert.equal(returned.collection, undefined); assert.equal(reads, 2);
  const moved = await worker.query(request({ segments: [[project([-1, 1]), project([1, 1])]], renderedKey: cold.renderKey }));
  assert.equal(moved.collection!.features.length, 0, 'old route candidates are clipped away');
});

test('date-line coverage follows the route longitude copy without changing cached landing geometry', async () => {
  const boxes: Bounds[] = [[179.6, -.05, 179.9, .05], [-179.9, -.05, -179.6, .05]];
  const rows = boxes.map(box => [record(box)]), parts = boxes.map((box, i) => shard(String(i), box, rows[i]!));
  let coverage: LandingManifest['coverage'] = [
    { id: 'east', bounds: [179, -1, 180, 1] }, { id: 'west', bounds: [-180, -1, -179, 1] },
  ];
  let reads = 0, renderedKey: string | undefined;
  const worker = createLandingWorker(async () => ({ ...manifest(parts), coverage }), async (_url, part) => {
    reads++; return decodeLandingAreas(rows[parts.indexOf(part)]!, part);
  });
  const segments: Segment[] = [[project([179, 0]), project([181, 0])]];
  const views: Bounds[] = [[179.5, -.1, 180.5, .1], [179.5, -.1, -179.5, .1],
    [-180.5, -.1, -179.5, .1], [539.5, -.1, 540.5, .1], [-540.5, -.1, -539.5, .1]];
  for (const bounds of views) {
    const result = await worker.query(request({ bounds, segments, ...(renderedKey ? { renderedKey } : {}) }));
    assert.equal(result.status.state, 'ready'); assert.equal(result.status.count, 2);
    if (renderedKey) assert.equal(result.collection, undefined, 'changing world copies keeps the rendered geometry');
    renderedKey = result.renderKey;
  }
  assert.equal(reads, 2, 'both date-line shards are acquired only once');
  coverage = [coverage[0]!];
  assert.equal((await worker.query(request({ bounds: views[0]!, segments, revalidate: true }))).status.state, 'partial');
  coverage = [{ id: 'elsewhere', bounds: [-2, -1, 2, 1] }];
  assert.equal((await worker.query(request({ bounds: views[0]!, segments, revalidate: true }))).status.state, 'outside');
  coverage = [{ id: 'world', bounds: [-180, -1, 180, 1] }];
  assert.equal((await worker.query(request({ bounds: views[0]!, segments, revalidate: true }))).status.state, 'ready');
});

test('only visible route-adjacent shards load; terrain-independent areas are clipped to 20 NM and keep tiers distinct', async () => {
  const rows = [[record([-.1, -.1, .1, .5], 1)], [record([-.05, -.05, .05, .05], 2)], [record([5, 5, 6, 6])]];
  const parts = [shard('low', [-.1, -.1, .1, .5], rows[0]!), shard('high', [-.05, -.05, .05, .05], rows[1]!), shard('far', [5, 5, 6, 6], rows[2]!)];
  const reads: string[] = [];
  const worker = createLandingWorker(async () => manifest(parts), async (_url, part) => {
    reads.push(part.id); return decodeLandingAreas(rows[parts.indexOf(part)]!, part);
  });
  const result = await worker.query(request());
  assert.deepEqual(reads, ['high', 'low'], 'load the file nearest the view center first');
  assert.deepEqual(result.collection!.features.map(feature => feature.properties.tier), [1, 2]);
  const points = result.collection!.features.flatMap(feature => feature.geometry.coordinates.flat(2));
  assert.ok(Math.max(...points.map(p => p[1]!)) < .334, 'route corridor clips the full candidate polygon');
  const clear = await worker.query(request({ segments: [], renderedKey: result.renderKey }));
  assert.equal(clear.status.state, 'route'); assert.equal(clear.collection!.features.length, 0); assert.equal(reads.length, 2);
});

test('unpublished feeds retry explicitly; same-input replacement artifacts invalidate stale decoded geometry', async () => {
  const rows = [record([-.2, -.05, .2, .05])], part = shard('a', [-.2, -.05, .2, .05], rows);
  let published = false, attempts = 0, reads = 0, doc = manifest([part]);
  const worker = createLandingWorker(async () => {
    attempts++; if (!published) throw new JsonResponseError('Not published', 404); return doc;
  }, async (_url, part) => { reads++; return decodeLandingAreas(rows, part); });
  assert.equal((await worker.query(request())).status.state, 'unavailable');
  assert.equal((await worker.query(request())).status.state, 'unavailable'); assert.equal(attempts, 1);
  published = true;
  const ready = await worker.query(request({ revalidate: true }));
  assert.equal(ready.status.state, 'ready'); assert.equal(reads, 1);
  doc = { ...doc, shards: [] };
  const empty = await worker.query(request({ revalidate: true, renderedKey: ready.renderKey }));
  assert.equal(empty.collection!.features.length, 0, 'even unchanged inputSha cannot hide an artifact replacement');
});

test('bounded gzip acquisition authenticates bytes before accepting polygons', async t => {
  const rows = [record([-.2, -.05, .2, .05])], part = shard('one', [-.2, -.05, .2, .05], rows);
  const compressed = gzipSync(JSON.stringify(rows) + '\n');
  t.mock.method(globalThis, 'fetch', async () => new Response(compressed, { headers: { 'Content-Length': String(compressed.length) } }));
  const signal = new AbortController().signal;
  assert.equal((await loadLandingShard('https://example.test/glide/manifest.json', part, signal)).length, 1);
  await assert.rejects(loadLandingShard('https://example.test/glide/manifest.json', { ...part, sha256: 'f'.repeat(64) }, signal), /SHA-256/);
  await assert.rejects(loadLandingShard('https://example.test/glide/manifest.json', { ...part, rawBytes: part.rawBytes - 1 }, signal), /size|exceeds/);
});

test('missing shards stay partial and cancellation cannot publish an obsolete acquisition', async () => {
  const rows = [[record([-.2, -.05, -.1, .05])], [record([.1, -.05, .2, .05])]];
  const parts = [shard('a', [-.2, -.05, -.1, .05], rows[0]!), shard('b', [.1, -.05, .2, .05], rows[1]!)];
  let failed = true;
  const worker = createLandingWorker(async () => manifest(parts), async (_url, part) => {
    if (part.id === 'b' && failed) throw new Error('Missing file');
    return decodeLandingAreas(rows[parts.indexOf(part)]!, part);
  });
  const partial = await worker.query(request());
  assert.equal(partial.status.state, 'partial'); assert.equal(partial.status.count, 1);
  failed = false;
  const complete = await worker.query(request({ renderedKey: partial.renderKey }));
  assert.equal(complete.status.state, 'ready'); assert.equal(complete.status.count, 2);

  let started!: () => void, finish!: () => void, first = true;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const cancelled = createLandingWorker(async () => manifest([parts[0]!]), async (_url, part) => {
    if (first) { first = false; started(); await gate; }
    return decodeLandingAreas(rows[0]!, part);
  });
  const pending = cancelled.query(request({ id: 9 }));
  await entered; cancelled.cancel(9); finish();
  await assert.rejects(pending, { name: 'AbortError' });
  const after = await cancelled.query(request({ id: 10, segments: [] }));
  assert.equal(after.collection!.features.length, 0);
});


test('schema 5 accepts 2,000 ft preferred fits and flagged fallbacks without weakening legacy validation', () => {
  const rows = [record([-.2, -.05, .2, .05], 2)];
  (rows[0]![0] as number[])[5] = 2000;
  const part = shard('v15', [-.2, -.05, .2, .05], rows);
  assert.ok(isLandingManifest({ ...manifest([part]), schemaVersion: 5, builderVersion: 15 }));
  assert.equal(decodeLandingAreas(rows, part, 5)[0]!.tier, 2);
  assert.throws(() => decodeLandingAreas(rows, part, 4));
  for (const flag of [16, 32, 64, 112]) {
    const fallback = [record([-.2, -.05, .2, .05], 1, [], flag)];
    assert.equal(decodeLandingAreas(fallback, shard('fallback', [-.2, -.05, .2, .05], fallback), 5)[0]!.flags, flag);
    const preferred = [record([-.2, -.05, .2, .05], 2, [], flag)];
    assert.throws(() => decodeLandingAreas(preferred, shard('invalid', [-.2, -.05, .2, .05], preferred), 5));
  }
});

test('schema 6 preserves bare/mixed surface uncertainty without accepting it as preferred or legacy data', async () => {
  const rows = [record([-.2, -.05, .2, .05], 1, [], 128)];
  const part = shard('v17', [-.2, -.05, .2, .05], rows);
  const document = { ...manifest([part]), schemaVersion: 6 as const, builderVersion: 17 };
  assert.ok(isLandingManifest(document));
  assert.equal(decodeLandingAreas(rows, part, 6)[0]!.flags, 128);
  assert.throws(() => decodeLandingAreas(rows, part, 5));
  const invalid = [record([-.2, -.05, .2, .05], 2, [], 128)];
  assert.throws(() => decodeLandingAreas(invalid, shard('bad', part.bounds, invalid), 6));
  const worker = createLandingWorker(async () => document, async () => decodeLandingAreas(rows, part, 6));
  const result = await worker.query(request());
  assert.equal(result.status.mixedOpen, true);
  assert.equal(result.collection!.features[0]!.properties.tier, 1);
});


test('schema 7 retains mapped-open, constrained-fit and obstacle uncertainty only on purple records', async () => {
  const flags = 8 | 256 | 512;
  const rows = [record([-.2, -.05, .2, .05], 1, [], flags)];
  (rows[0]![0] as number[])[4] = 100;
  const part = shard('v18', [-.2, -.05, .2, .05], rows);
  const document = { ...manifest([part]), schemaVersion: 7 as const, builderVersion: 18 };
  assert.ok(isLandingManifest(document));
  assert.equal(decodeLandingAreas(rows, part, 7)[0]!.flags, flags);
  assert.throws(() => decodeLandingAreas(rows, part, 6));
  const worker = createLandingWorker(async () => document, async () => decodeLandingAreas(rows, part, 7));
  const result = await worker.query(request());
  assert.equal(result.status.canopyUncertain, true);
  assert.equal(result.status.constrained, true);
  assert.equal(result.status.obstacleUncertain, true);
  for (const flag of [8, 256, 512, 1024]) {
    const invalid = [record([-.2, -.05, .2, .05], 2, [], flag)];
    assert.throws(() => decodeLandingAreas(invalid, shard('bad', part.bounds, invalid), 7));
  }
});


test('landing widths obey each schema floor and require narrow-fit disclosure', () => {
  for (const version of [4, 5, 6, 7, 8] as const) {
    for (const tier of [1, 2]) {
      const cases: [number, number, boolean][] = tier === 2 || version < 7 ? [[199, 0, false], [200, 0, true]]
        : version === 7 ? [[99, 256, false], [100, 256, true], [100, 0, false], [200, 0, true]]
          : [[59, 256, false], [60, 256, true], [99, 0, false], [100, 0, true]];
      for (const [width, flags, accepted] of cases) {
        const rows = [record([-.2, -.05, .2, .05], tier, [], flags)];
        (rows[0]![0] as number[])[4] = width;
        const part = shard('width', [-.2, -.05, .2, .05], rows);
        const decode = () => decodeLandingAreas(rows, part, version);
        if (accepted) assert.doesNotThrow(decode, `schema ${version}, tier ${tier}, width ${width}`);
        else assert.throws(decode, /Invalid landing-area qualification/);
      }
    }
  }
});

test('schema 8 accepts flagged short last-resort openings without weakening legacy or green checks', () => {
  const rows = [record([-.2, -.05, .2, .05], 1, [], 256)];
  rows[0]![0] = [-1000, 0, 1000, 0, 60, 600, 50, 1];
  const part = shard('short', [-.2, -.05, .2, .05], rows);
  assert.ok(isLandingManifest({ ...manifest([part]), schemaVersion: 8, builderVersion: 20 }));
  assert.equal(decodeLandingAreas(rows, part, 8)[0]!.tier, 1);
  assert.throws(() => decodeLandingAreas(rows, part, 7));
  for (const [width, length, flags] of [[59, 600, 256], [60, 599, 256], [60, 600, 0]]) {
    const bad = structuredClone(rows); (bad[0]![0] as number[])[4] = width!; (bad[0]![0] as number[])[5] = length!; bad[0]![2] = flags!;
    assert.throws(() => decodeLandingAreas(bad, part, 8));
  }
  const badGreen = [record([-.2, -.05, .2, .05], 2)];
  (badGreen[0]![0] as number[])[4] = 60;
  assert.throws(() => decodeLandingAreas(badGreen, shard('green', [-.2, -.05, .2, .05], badGreen), 8));
});


test('national manifests may exceed the local cache while each shard remains bounded', () => {
  const parts = Array.from({ length: 50 }, (_, i) => {
    const sha256 = i.toString(16).padStart(64, '0');
    return { id: `nation-${i}`, file: `${sha256}.glide.gz`, sha256, bounds: [-100, 30, -99, 31] as Bounds,
      count: 1, tiers: [1, 0] as [number, number], bytes: 2 * 1024 * 1024, rawBytes: 8 * 1024 * 1024 };
  });
  assert.ok(isLandingManifest(manifest(parts)));
  assert.equal(isLandingManifest(manifest([{ ...parts[0]!, bytes: 2 * 1024 * 1024 + 1 }])), false);
  assert.equal(isLandingManifest(manifest([parts[0]!, parts[0]!])), false);
});

test('inspection retains individual qualifications and flags after visual union, respecting holes and route edits', async () => {
  const rows = [record([-.2, -.05, 0, .05], 1, [[-.15, -.02, -.1, .02]], 2), record([0, -.05, .2, .05], 1, [], 1)];
  const part = shard('inspect', [-.2, -.05, .2, .05], rows);
  const worker = createLandingWorker(async () => manifest([part]), async () => decodeLandingAreas(rows, part));
  const result = await worker.query(request());
  assert.equal(result.collection!.features[0]!.properties.flags, 3);
  const left = worker.inspect([-.18, 0])!, right = worker.inspect([.1, 0])!;
  assert.equal(left.flags, 2); assert.equal(right.flags, 1); assert.notEqual(left.id, right.id);
  assert.equal(right.lengthFt, 1500); assert.equal(right.widthFt, 200); assert.equal(right.elevationM, 50);
  assert.deepEqual(right.start, [0, 0]); assert.deepEqual(right.end, [.2, 0]);
  assert.equal(worker.inspect([-.125, 0]), null, 'hole is not a landing site');
  assert.equal(worker.inspect([360.1, 0])!.id, right.id);
  await worker.query(request({ segments: [] }));
  assert.equal(worker.inspect([.1, 0]), null);
});

test('dense views load useful candidates up to the memory budget instead of showing nothing', async () => {
  const rows = [[record([-.2, -.05, -.1, .05])], [record([.1, -.05, .2, .05])], [record([.3, -.05, .4, .05])]];
  const parts = rows.map((r, i) => ({ ...shard(String(i), [-.5, -.1, .5, .1], r), rawBytes: 12 * 1024 * 1024 }));
  let reads = 0;
  const worker = createLandingWorker(async () => manifest(parts), async (_url, part) => {
    reads++; return decodeLandingAreas(rows[parts.indexOf(part)]!, part);
  });
  const result = await worker.query(request());
  assert.equal(result.status.state, 'limited'); assert.equal(result.status.count, 2); assert.equal(reads, 2);
  await worker.query(request()); assert.equal(reads, 2, 'do not repeatedly acquire an unretainable shard');
});

test('dense shards select whole visible candidates before the vertex limit and reselect after a pan', async () => {
  const rows = [record([-.2, -.05, .2, .05]), record([1.8, -.05, 2.2, .05]), record([5, 5, 5.3, 5.1])];
  const dense: Point[] = Array.from({ length: 300001 }, (_, i) => [5 + i / 1e6, 5]);
  dense.push([5.3, 5.1], [5, 5.1]);
  rows[2]![1] = [encode(dense)];
  const part = shard('dense', [-.2, -.05, 5.3, 5.1], rows);
  let reads = 0;
  const worker = createLandingWorker(async () => manifest([part]), async () => {
    reads++; return decodeLandingAreas(rows, part);
  });
  const route: Segment[] = [[project([-1, 0]), project([3, 0])]];
  const first = await worker.query(request({ bounds: [-.1, -.1, .1, .1], segments: route }));
  assert.equal(first.status.count, 1, 'off-screen vertices cannot reject the entire file');
  assert.equal(first.status.state, 'ready');
  const ring = first.collection!.features[0]!.geometry.coordinates[0]![0]!;
  assert.ok(Math.min(...ring.map(p => p[0]!)) < -.19, 'retain the whole area beyond the viewport edge');
  await worker.query(request({ bounds: [-.1, -.1, .1, .1], segments: route, renderedKey: first.renderKey }));
  assert.equal(reads, 1, 'unchanged view reuses its selected records');
  const next = await worker.query(request({ bounds: [1.9, -.1, 2.1, .1], segments: route, renderedKey: first.renderKey }));
  assert.equal(next.status.count, 2); assert.equal(reads, 2, 'new view adds records from the cached file');
  assert.ok(worker.inspect([0, 0]), 'previously visited polygons remain within the budget');
  assert.ok(worker.inspect([2, 0]));
  assert.notEqual(next.renderKey, first.renderKey, 'new records under the same shard identity reach the map');
  await worker.query(request({ segments: [] }));
  const restored = await worker.query(request({ bounds: [1.9, -.1, 2.1, .1], segments: route }));
  assert.equal(restored.status.count, 1, 'route restoration clears prior selection attempts');
});

test('partial shards retain visited areas through pans, failed reloads and cancellation', async () => {
  const rows = [record([-.4, -.04, -.3, .04]), record([-.05, -.04, .05, .04]), record([.3, -.04, .4, .04])];
  const part = shard('partial', [-.4, -.04, .4, .04], rows);
  let reads = 0, fail = false, gate: Promise<void> | undefined;
  let entered: (() => void) | undefined;
  const worker = createLandingWorker(async () => manifest([part]), async () => {
    reads++; entered?.(); await gate;
    if (fail) throw new Error('reload unavailable');
    return decodeLandingAreas(rows, part);
  });
  const first = await worker.query(request({ bounds: [-.45, -.05, -.25, .05] }));
  const pan = await worker.query(request({ bounds: [-.44, -.05, -.24, .05], renderedKey: first.renderKey }));
  assert.equal(reads, 1, 'camera movement away from omitted areas needs no decoding');
  assert.equal(pan.collection, undefined);
  const second = await worker.query(request({ bounds: [-.1, -.05, .1, .05] }));
  assert.equal(second.status.count, 2); assert.equal(reads, 2);
  assert.ok(worker.inspect([-.35, 0])); assert.ok(worker.inspect([0, 0]));
  const returned = await worker.query(request({ bounds: [359.55, -.05, 359.75, .05], renderedKey: second.renderKey }));
  assert.equal(returned.collection, undefined); assert.equal(reads, 2, 'visited world copies keep their polygons');
  fail = true;
  const failed = await worker.query(request({ bounds: [.25, -.05, .45, .05], renderedKey: second.renderKey }));
  assert.equal(failed.status.state, 'partial'); assert.equal(failed.status.count, 2);
  assert.equal(failed.collection, undefined); assert.ok(worker.inspect([0, 0]));
  fail = false;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let finish!: () => void;
  gate = new Promise<void>(resolve => { finish = resolve; });
  const pending = worker.query(request({ id: 10, bounds: [.25, -.05, .45, .05] }));
  await started; worker.cancel(10); finish();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.ok(worker.inspect([-.35, 0])); assert.ok(worker.inspect([0, 0]));
  assert.equal(worker.inspect([.35, 0]), null);
  const complete = await worker.query(request({ bounds: [.25, -.05, .45, .05] }));
  assert.equal(complete.status.count, 3);
  const totalReads = reads;
  await worker.query(request());
  assert.equal(reads, totalReads, 'the fully accumulated shard no longer needs selection reloads');
});

test('accumulating partial shards still evicts older polygons at the vertex budget', async () => {
  const boxes: Bounds[] = [[-.4, -.04, -.3, .04], [.3, -.04, .4, .04]];
  const rows = boxes.map(box => {
    const row = record(box);
    row[1] = [encode(rect(box).flatMap(point => Array.from({ length: 40000 }, () => point)))];
    return row;
  });
  const part = shard('budget', [-.4, -.04, .4, .04], rows);
  let reads = 0;
  const worker = createLandingWorker(async () => manifest([part]), async () => { reads++; return decodeLandingAreas(rows, part); });
  await worker.query(request({ bounds: [-.45, -.05, -.25, .05] }));
  assert.ok(worker.inspect([-.35, 0]));
  const moved = await worker.query(request({ bounds: [.25, -.05, .45, .05] }));
  assert.equal(moved.status.count, 1);
  assert.ok(worker.inspect([.35, 0]));
  assert.equal(worker.inspect([-.35, 0]), null, 'old offscreen vertices are evicted when both areas cannot fit');
  await worker.query(request({ bounds: [.26, -.05, .46, .05] }));
  assert.equal(reads, 2, 'a nearby pan does not reopen the shard');
  await worker.query(request({ bounds: [-.45, -.05, -.25, .05] }));
  assert.equal(reads, 3); assert.ok(worker.inspect([-.35, 0]));
  assert.equal(worker.inspect([.35, 0]), null);
});

test('a file must intersect the route inside the viewport before it is acquired', async () => {
  const rows = [record([-.2, 1.9, .2, 2.1])];
  const part = shard('broad', [-.2, -.1, .2, 2.1], rows);
  let reads = 0;
  const worker = createLandingWorker(async () => manifest([part]), async () => { reads++; return decodeLandingAreas(rows, part); });
  const result = await worker.query(request({ segments: [[project([-1, 2]), project([1, 2])]] }));
  assert.equal(reads, 0, 'independent bounds overlaps must not acquire off-screen route data');
  assert.equal(result.collection!.features.length, 0);
});


test('schema 9 carries overall fit grades, cover disagreement and unavailable shrub evidence through inspection', async () => {
  const box: Bounds = [-.2, -.05, .2, .05];
  const rows = [record(box, 1, [], 1024 | 256)];
  const fit = rows[0]![0] as number[];
  fit[4] = 60; fit[5] = 600; fit.push(-35, 12);
  const part = shard('refined', box, rows);
  const doc: LandingManifest = { ...manifest([part]), schemaVersion: 9, builderVersion: 1,
    coverage: [{ id: 'sample', bounds: [-2, -2, 2, 2], shrubEvidenceMissing: true }] };
  assert.ok(isLandingManifest(doc));
  assert.equal(isLandingManifest({ ...doc, coverage: [{ ...doc.coverage[0], shrubEvidenceMissing: 'yes' }] }), false);
  const [decoded] = decodeLandingAreas(rows, part, 9);
  assert.equal(decoded!.alongGradePercent, -3.5);
  assert.equal(decoded!.crossGradePercent, 1.2);
  assert.throws(() => decodeLandingAreas(rows, part, 8), 'legacy schema cannot silently consume new tuples');
  const worker = createLandingWorker(async () => doc, async () => decodeLandingAreas(rows, part, 9));
  const result = await worker.query(request());
  assert.equal(result.status.coverUncertain, true);
  assert.equal(result.status.shrubEvidenceMissing, true);
  assert.equal(worker.inspect([0, 0])!.alongGradePercent, -3.5);
  assert.equal(worker.inspect([0, 0])!.crossGradePercent, 1.2);
  const moved = await worker.query(request({ bounds: [5, 5, 6, 6] }));
  assert.equal(moved.status.shrubEvidenceMissing, false);
  for (const badGrade of [NaN, 1.5, -1001, 1001]) {
    const bad = structuredClone(rows); (bad[0]![0] as number[])[8] = badGrade;
    assert.throws(() => decodeLandingAreas(bad, shard('bad', box, bad), 9));
  }
  const green = structuredClone(rows), greenFit = green[0]![0] as number[];
  greenFit[4] = 200; greenFit[5] = 2000; greenFit[7] = 2;
  assert.throws(() => decodeLandingAreas(green, shard('bad-green', box, green), 9), 'cover disagreement never promotes green');
  const legacy = [record(box)];
  assert.equal(decodeLandingAreas(legacy, shard('old', box, legacy), 8)[0]!.alongGradePercent, undefined);
});


test('vector limits admit nearby blocks and records from the range origin even when the camera favors outer ground', async () => {
  const boxes: Bounds[] = [[-.4, -.04, -.3, .04], [-.05, -.04, .05, .04], [.3, -.04, .4, .04]];
  const rows = boxes.map(box => [record(box)]);
  const parts = rows.map((r, i) => ({ ...shard(String(i), boxes[i]!, r), rawBytes: 12 * 1024 * 1024 }));
  const reads: string[] = [];
  const worker = createLandingWorker(async () => manifest(parts), async (_url, part) => {
    reads.push(part.id); return decodeLandingAreas(rows[parts.indexOf(part)]!, part);
  });
  const ranges = { type: 'FeatureCollection' as const, features: [{ type: 'Feature' as const, properties: { glideOrigin: [.35, 0] },
    geometry: { type: 'MultiPolygon' as const, coordinates: [[rect([-.5, -.09, .5, .09]).concat([[-.5, -.09]])]] } }] };
  const view = request({ bounds: [-.6, -.1, .45, .1], ranges });
  const result = await worker.query(view);
  assert.equal(result.status.state, 'limited'); assert.deepEqual(reads, ['2', '1']);
  assert.ok(worker.inspect([.35, 0])); assert.ok(worker.inspect([0, 0])); assert.equal(worker.inspect([-.35, 0]), null);
  const denseRows = [boxes[0]!, boxes[2]!].map(box => {
    const row = record(box); row[1] = [encode(rect(box).flatMap(point => Array.from({ length: 40000 }, () => point)))]; return row;
  });
  const part = shard('dense', [-.4, -.04, .4, .04], denseRows);
  const dense = createLandingWorker(async () => manifest([part]), async () => decodeLandingAreas(denseRows, part));
  assert.equal((await dense.query(view)).status.state, 'limited');
  assert.ok(dense.inspect([.35, 0])); assert.equal(dense.inspect([-.35, 0]), null);
});
