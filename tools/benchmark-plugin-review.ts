/** Local synthetic CPU/retention evidence; no network, tests or device/GPU claims.
 * Run: node --expose-gc --import=tsx tools/benchmark-plugin-review.ts
 * Each scenario runs in a fresh process with its own collected baseline.
 */
import { Ahrs } from '../src/layers/ahrs/estimator/ahrs';
import { spawnSync } from 'node:child_process';
import { FlightAlignment } from '../src/layers/ahrs/estimator/flight-alignment';
import { G } from '../src/layers/ahrs/estimator/math';
import { TerrainVectorCache } from '../src/layers/terrain/vector-cache';
import { terrainIsolines } from '../src/layers/terrain/isolines';
import { project, type Point } from '../src/core/geo/route-corridor';
import { GlidePlanner } from '../src/layers/glide/planner';
import { boundsViewport } from '../src/layers/glide/coverage';
import { packGridBands, compressGrid, inflatePacked, unpackGrid } from '../src/layers/weather-awc/grids/packed';
import { WindInterpolation } from '../src/layers/weather-awc/grids/wind-interpolation';
import { rasterGrid } from '../src/layers/weather-awc/grids/raster';
import { fullGridViewport } from '../src/layers/weather-awc/grids/viewport';
import type { AwcGridManifest } from '@zlayer/contracts';

if (!global.gc) throw new Error('Use --expose-gc');
const memory = async () => {
  await new Promise<void>(resolve => setImmediate(resolve)); global.gc!();
  await new Promise<void>(resolve => setImmediate(resolve)); global.gc!();
  const { heapUsed, arrayBuffers } = process.memoryUsage(); return { heapUsed, arrayBuffers };
};
const delta = (after: Awaited<ReturnType<typeof memory>>, before: Awaited<ReturnType<typeof memory>>) =>
  ({ heapBytes: after.heapUsed - before.heapUsed, arrayBufferBytes: after.arrayBuffers - before.arrayBuffers });
const stats = (values: number[]) => {
  values.sort((a, b) => a - b);
  return { medianMs: values[Math.floor(values.length / 2)], p95Ms: values[Math.floor(values.length * .95)], maxMs: values.at(-1) };
};
const timed = (run: () => unknown) => { const start = performance.now(); run(); return performance.now() - start; };
const report = (scenario: string, values: object) => console.log(JSON.stringify({ scenario, ...values }));

async function terrain(byteLimit: number) {
  const before = await memory(), cache = new TerrainVectorCache(128, byteLimit);
  // Saturated decoded-cache budgets plus four concurrent 512² RGBA outputs.
  const decoded = new Uint8Array(40 * 1024 * 1024), temporary = new Uint8Array(4 * 512 * 512 * 4);
  const size = 64, tile = { z: 11, x: 1024, y: 1024 };
  const values = Float32Array.from({ length: size * size }, (_, i) => 4000 + 2800 * Math.sin(i % size / size * 12 * Math.PI) * Math.cos(Math.floor(i / size) / size * 12 * Math.PI));
  const segments: [Point, Point][] = [[[.5, .5], [.501, .501]]];
  const vectors = terrainIsolines(values, size, tile, segments, 500, 512);
  cache.setVisible(['0', '1', '2', '3']);
  for (let i = 0; i < 128; i++) cache.put(String(i), structuredClone(vectors));
  const retained = await memory();
  report('terrain-128-dense-vector-tiles', { ...delta(retained, before), tileJsonBytes: Buffer.byteLength(JSON.stringify(vectors)),
    decodedBudgetBytes: decoded.byteLength, concurrentRgbaBytes: temporary.byteLength, retainedTiles: cache.size,
    byteLimit: Number.isFinite(byteLimit) ? byteLimit : 'entry-only', estimatedVectorBytes: cache.estimatedBytes });
  cache.clear();
}

async function glide() {
  const planner = new GlidePlanner(async () => new Float32Array(65536));
  const airports = Array.from({ length: 12 }, (_, i) => {
    const coordinate: Point = [-.1 + i * .018, 0], id = String(i);
    return { id, coordinate, elevationFt: 0, feature: { type: 'Feature' as const, id,
      geometry: { type: 'Point' as const, coordinates: coordinate }, properties: { faaId: id, kind: 'landing-facility' } } };
  });
  const result = await planner.calculate({ id: 1, airports, altitude: 6500, ratio: 8,
    viewport: boundsViewport([-.35, -.3, .35, .3]), segments: [[project([-.3, 0]), project([.3, 0])]],
    ownship: [.03, 0], point: null, sources: [], sourceKey: 'probe', base: 'https://example.invalid', tileUrl: '' }, new AbortController().signal);
  const { areas, airports: features, ...common } = result;
  const full = { ...common, planKey: '1:1', airportCount: features.length, plan: { areas, airports: features } };
  const accepted = { ...common, planKey: '1:1', airportCount: features.length };
  report('glide-12-airport-clone', { fullBytes: Buffer.byteLength(JSON.stringify(full)), acceptedBytes: Buffer.byteLength(JSON.stringify(accepted)),
    full: stats(Array.from({ length: 40 }, () => timed(() => structuredClone(full)))),
    accepted: stats(Array.from({ length: 40 }, () => timed(() => structuredClone(accepted)))) });
}

async function weather() {
  const before = await memory(), size = 512, count = size * size;
  const manifest: AwcGridManifest = { schemaVersion: 1, product: 'clouds', model: 'HRRR', generation: 'probe',
    runTime: 0, checkedAt: 0, publishedAt: 0, cadenceMs: 3600000,
    grid: { projection: 'EPSG:3857', width: size, height: size, bounds: [-126, 22, -65, 51] },
    fields: ['cloudCover', 'cloudBase', 'cloudTop', 'freezingLowest', 'freezingHighest'], frames: [] };
  const values = Float32Array.from({ length: count * 5 }, (_, i) => i < count ? i % 101 : 10000);
  const packed = packGridBands(values, manifest), compressed = await compressGrid(packed.buffer);
  const start = performance.now(), buffer = await inflatePacked(compressed, manifest), bands = unpackGrid(buffer, manifest);
  const decodeMs = performance.now() - start;
  const frame = { validTime: 0, altitudeFtMsl: null, path: 'probe', bytes: compressed.byteLength,
    decodedBytes: 16 + values.byteLength, sha256: '', sources: [] };
  const data = { manifest, frame, bands, byteLength: buffer.byteLength };
  const rasterStart = performance.now(), raster = await rasterGrid(data, 'cloudCover', false, fullGridViewport(manifest), new AbortController().signal);
  const rasterMs = performance.now() - rasterStart;
  const output = new Float32Array(count * 4), terrain = new Float32Array(count);
  const wind = new WindInterpolation(8000, output, terrain);
  const level = (height: number) => Float32Array.from({ length: count * 4 }, (_, i) => i < count ? height : i < 2 * count ? 20 : i < 3 * count ? -10 : 5);
  const lower = level(4500), upper = level(10000);
  const windMs = timed(() => { wind.add(850, lower); wind.add(700, upper); });
  const retained = await memory();
  report('weather-512-square-scalar-wind-raster', { ...delta(retained, before), decodeMs, rasterMs, windMs,
    denseScalarBytes: values.byteLength, compactScalarBytes: buffer.byteLength, compressedBytes: compressed.byteLength,
    windBuffersBytes: output.byteLength + lower.byteLength + upper.byteLength + terrain.byteLength, rgbaBytes: raster.byteLength });
}

async function ahrs(delay: number) {
  const before = await memory(), filter = new Ahrs(), imu: number[] = [], gps: number[] = [];
  for (let i = 0; i <= 12 * 120; i++) {
    const time = i / 120;
    imu.push(timed(() => filter.update({ time, gyro: [0, 0, 0], specificForce: [0, 0, -G] })));
    if (i >= 120 && i % 120 === 0) gps.push(timed(() => filter.updateGps({ time: time - delay,
      speed: 50, track: 0, accuracy: 3, altitude: null, altitudeAccuracy: null })));
  }
  const retained = await memory();
  report('ahrs-120hz-12s', { delaySeconds: delay, ...delta(retained, before), imu: stats(imu), gps: stats(gps), status: filter.getState(12).status });
}

function calibration() {
  const alignment = new FlightAlignment();
  for (let i = 0; i <= 1200; i++) alignment.observeImu({ time: i / 120, gyro: [0, 0, 0], specificForce: [0, 0, -G] });
  report('calibration-unchanged-rejected-window', { reason: alignment.snapshot(10).reason,
    duplicateReads: stats(Array.from({ length: 1000 }, () => timed(() => alignment.snapshot(10)))) });
}

const scenarios: Record<string, () => unknown> = { 'terrain-before': () => terrain(Infinity), 'terrain-after': () => terrain(32 * 1024 * 1024),
  glide, weather, 'ahrs-current': () => ahrs(0), 'ahrs-delayed': () => ahrs(.25), calibration };
const selected = process.argv[2];
if (selected) {
  if (!scenarios[selected]) throw new Error(`Unknown scenario ${selected}`);
  await scenarios[selected]();
} else {
  report('environment', { node: process.version, platform: process.platform, architecture: process.arch });
  for (const scenario of Object.keys(scenarios)) {
    const child = spawnSync(process.execPath, ['--expose-gc', '--import=tsx', import.meta.filename, scenario], { stdio: 'inherit' });
    if (child.error) throw child.error;
    if (child.status !== 0) throw new Error(`${scenario} exited with ${child.status}`);
  }
}
