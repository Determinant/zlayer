// Synthetic worker CPU diagnostic; excludes network, decoding and map/GPU work.
// Run: node --import=tsx tools/benchmark-glide-landings.ts
import { createHash } from 'node:crypto';
import type { Bounds } from '@zlayer/contracts';
import { project, type Point, type Segment } from '../src/core/geo/route-corridor';
import { landingHeatImage, type LandingHeat } from '../src/layers/glide/landing-heat';
import { createLandingWorker, type LandingQuery } from '../src/layers/glide/landing-planner';
import type { LandingArea, LandingManifest, LandingShard } from '../src/layers/glide/landing-data';
import type { GlideAreas } from '../src/layers/glide/types';

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex').slice(0, 16);
const median = (values: number[]) => +values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!.toFixed(2);
const bounds: Bounds = [-.5, -.35, .5, .35];
const segments: Segment[] = [[project([-.7, -.08]), project([.7, .08])], [project([-.7, .15]), project([.7, -.15])]];
const heats: LandingHeat[] = Array.from({ length: 32 }, (_, i) => {
  const west = -.5 + i % 8 * .125, south = -.35 + Math.floor(i / 8) * .175;
  const a = project([west, south + .19]), b = project([west + .14, south]);
  return { extent: [a[0], a[1], b[0], b[1]], width: 128, height: 128, flags: 1,
    cells: Uint8Array.from({ length: 128 * 128 }, (_, j) => (j * 13 + Math.floor(j / 128) * 7 + i) % 11 < 4 ? 0 : (i + j) % 2 + 1) };
});
const overlapping = heats.map(grid => ({ ...grid, extent: [heats[0]!.extent[0], heats[24]!.extent[1], heats[7]!.extent[2], heats[0]!.extent[3]] as Bounds }));
const areaRing = (x: number, y: number, radius: number, vertices: number): Point[] => {
  const ring = Array.from({ length: vertices }, (_, i): Point => {
    const angle = i / vertices * 2 * Math.PI, r = radius * (i % 2 ? .9 : 1);
    return [x + r * Math.cos(angle), y + r * Math.sin(angle)];
  });
  return [...ring, ring[0]!];
};
const areas: LandingArea[] = Array.from({ length: 768 }, (_, i) => {
  const x = -.465 + i % 32 * .03, y = -.32 + Math.floor(i / 32) * .028;
  return { id: String(i), tier: i % 3 ? 2 : 1, flags: i % 3 ? 1 : 2,
    start: [x - .005, y], end: [x + .005, y], widthFt: 200, lengthFt: 3000, elevationM: 50,
    polygon: [areaRing(x, y, .012, 24).map(project), ...(i % 7 ? [] : [areaRing(x, y, .003, 8).map(project)])] };
});
const shard: LandingShard = { id: 'sample', file: `${'a'.repeat(64)}.glide.gz`, sha256: 'a'.repeat(64), bounds,
  bytes: 50000, rawBytes: 500000, count: areas.length, tiers: [256, 512] };
const manifest: LandingManifest = { schemaVersion: 9, builderVersion: 1, inputSha256: 'b'.repeat(64),
  generatedAt: '2026-10-03T00:00:00Z', status: 'experimental-candidates', geometryMeaning: 'generalized-candidate-area',
  coverage: [{ id: 'sample', bounds: [-2, -2, 2, 2] }], shards: [shard] };
const ranges = (radius: number): GlideAreas => ({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {},
  geometry: { type: 'MultiPolygon', coordinates: [[areaRing(0, 0, radius, 180)]] } }] });
const request: LandingQuery = { id: 1, manifestUrl: 'https://example.test/glide/manifest.json', bounds, segments: [],
  discover: true, ranges: ranges(.6) };
const timings = { heat: [] as number[], heatOverlap: [] as number[], heatPoint: [] as number[], cold: [] as number[], range: [] as number[], camera: [] as number[] };
let evidence: object = {};
for (let run = 0; run < 6; run++) {
  let reads = 0;
  const worker = createLandingWorker(async () => manifest, async () => { reads++; return areas; });
  const start = performance.now(), heat = landingHeatImage(heats, bounds, 11, segments), heatDone = performance.now();
  const overlap = landingHeatImage(overlapping, bounds, 11, segments), overlapDone = performance.now();
  const point = landingHeatImage(heats, bounds, 11, [[project([0, 0]), project([0, 0])]]), pointDone = performance.now();
  const cold = await worker.query(request), coldDone = performance.now();
  const changed = await worker.query({ ...request, ranges: ranges(.4), renderedKey: cold.renderKey }), rangeDone = performance.now();
  const camera = await worker.query({ ...request, ranges: ranges(.4), bounds: [-.45, -.3, .45, .3], renderedKey: changed.renderKey }), done = performance.now();
  if (run) { timings.heat.push(heatDone - start); timings.heatOverlap.push(overlapDone - heatDone); timings.heatPoint.push(pointDone - overlapDone);
    timings.cold.push(coldDone - pointDone);
    timings.range.push(rangeDone - coldDone); timings.camera.push(done - rangeDone); }
  evidence = { heatSize: [heat.width, heat.height], heatDigest: digest(new Uint8Array(heat.rgba.buffer)),
    overlapDigest: digest(new Uint8Array(overlap.rgba.buffer)), pointDigest: digest(new Uint8Array(point.rgba.buffer)),
    coldDigest: digest(JSON.stringify(cold.collection)), rangeDigest: digest(JSON.stringify(changed.collection)),
    coldPatches: cold.status.count, rangePatches: changed.status.count, reads, cameraUploaded: !!camera.collection };
}
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, grids: heats.length, polygons: areas.length,
  medianMs: Object.fromEntries(Object.entries(timings).map(([key, values]) => [key, median(values)])), ...evidence }));
