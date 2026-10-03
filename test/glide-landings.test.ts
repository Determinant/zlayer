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
  assert.deepEqual(reads, ['low', 'high']);
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
