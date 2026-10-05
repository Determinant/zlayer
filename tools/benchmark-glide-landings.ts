// Synthetic worker CPU diagnostic; excludes network, decoding and map/GPU work.
// Run: node --import=tsx tools/benchmark-glide-landings.ts
import { createHash } from 'node:crypto';
import type { Bounds } from '@zlayer/contracts';
import { project, unproject, type Point, type Segment } from '../src/core/geo/route-corridor';
import { landingHeatImage, type LandingHeat } from '../src/layers/glide/landing-heat';
import { createLandingWorker, type LandingQuery } from '../src/layers/glide/landing-planner';
import type { LandingArea, LandingManifest, LandingShard } from '../src/layers/glide/landing-data';
import type { GlideAreas } from '../src/layers/glide/types';
import { createLandingDisplayWorker, type LandingDisplayQuery } from '../src/layers/glide/landing-display';

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
// Four published-format z10 overviews at the actual z11 display cell scale.
// Injected reads isolate composition/progression from acquisition and decoding.
const overviewGrids: LandingHeat[] = Array.from({ length: 4 }, (_, i) => ({ density: true,
  extent: [(164 + i % 2) / 1024, (405 + Math.floor(i / 2)) / 1024, (165 + i % 2) / 1024, (406 + Math.floor(i / 2)) / 1024],
  width: 256, height: 256, flags: 0, cells: Uint8Array.from({ length: 256 * 256 * 3 }, (_, j) =>
    j % 3 === 2 ? 255 : (Math.floor(j / 3) * (j % 3 === 0 ? 7 : 13)) % 128) }));
const geographicBounds = ([w, n, e, s]: Bounds): Bounds => {
  const a = unproject([w, n]), b = unproject([e, s]); return [a[0], b[1], b[0], a[1]];
};
const overviewBounds = geographicBounds([164.25 / 1024, 405.25 / 1024, 165.625 / 1024, 406.125 / 1024]);
const overviewManifest: LandingManifest = { ...manifest, coverage: [{ id: 'numeric', bounds: [-124, 33, -120, 37] }],
  shards: overviewGrids.map((grid, i) => ({ ...shard, id: String(i), file: String(i), bounds: geographicBounds(grid.extent), count: 0, tiers: [0, 0] })) };
const latitude = (overviewBounds[1] + overviewBounds[3]) / 2;
const overviewRequest: LandingDisplayQuery = { id: 1, manifestUrl: request.manifestUrl, bounds: overviewBounds, zoom: 11, discover: true,
  segments: [[project([overviewBounds[0], latitude]), project([overviewBounds[2], latitude])]], ranges: { type: 'FeatureCollection', features: [] } };
const overviewTimings = { compose: [] as number[], cold: [] as number[], warm: [] as number[], smallPan: [] as number[], revisit: [] as number[] };
let overviewEvidence: object = {};
for (let run = 0; run < 8; run++) {
  let reads = 0, publications = 0;
  const worker = createLandingDisplayWorker(async () => overviewManifest, async (_url, shard) => {
    reads++; return overviewGrids[Number(shard.id)]!;
  }, async () => { throw new Error('Overview must not acquire polygons'); });
  const start = performance.now(), image = landingHeatImage(overviewGrids, overviewBounds, 11, overviewRequest.segments), composed = performance.now();
  let result = await worker.query(overviewRequest);
  publications += Number(!!result.heat);
  while (result.more) { result = await worker.query({ ...overviewRequest, renderedKey: result.renderKey }); publications += Number(!!result.heat); }
  const cold = performance.now();
  const warm = await worker.query({ ...overviewRequest, renderedKey: result.renderKey }), warmed = performance.now();
  const pan = await worker.query({ ...overviewRequest, bounds: overviewBounds.map((value, i) => i % 2 ? value : value + .01) as Bounds,
    renderedKey: warm.renderKey }), panned = performance.now();
  const revisit = await worker.query({ ...overviewRequest, renderedKey: pan.renderKey }), done = performance.now();
  if (run >= 2) {
    overviewTimings.compose.push(composed - start); overviewTimings.cold.push(cold - composed); overviewTimings.warm.push(warmed - cold);
    overviewTimings.smallPan.push(panned - warmed); overviewTimings.revisit.push(done - panned);
  }
  overviewEvidence = { size: [image.width, image.height], digest: digest(new Uint8Array(image.rgba.buffer)), reads, publications,
    warmUploaded: !!warm.heat, smallPanUploaded: !!pan.heat, revisitUploaded: !!revisit.heat };
}
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, grids: heats.length, polygons: areas.length,
  medianMs: Object.fromEntries(Object.entries(timings).map(([key, values]) => [key, median(values)])), ...evidence,
  overview: { medianMs: Object.fromEntries(Object.entries(overviewTimings).map(([key, values]) => [key, median(values)])), ...overviewEvidence } }));
