import assert from 'node:assert/strict';
import test from 'node:test';
import { nmPerWorldUnit, project, type Point } from '../src/core/geo/route-corridor';
import { ElevationTilePool } from '../src/core/terrain/elevation-pool';
import { elevationGridLayout, readElevationGrid } from '../src/core/terrain/elevation';
import { FEET_PER_NM } from '../src/layers/glide/airports';
import { GLIDE_SECTORS, prepareGlideProfile, profileFootprint, type GlideProfile } from '../src/layers/glide/profile';
import { ownshipOutline } from '../src/layers/glide/geometry';
import { boundsViewport } from '../src/layers/glide/coverage';
import { planningElevationGrid } from './helpers/glide';
import { GlidePlanner } from '../src/layers/glide/planner';

const scale = nmPerWorldUnit(.5) * FEET_PER_NM, stepNm = .2;
function profile(samples: number[]): GlideProfile {
  const step = stepNm * FEET_PER_NM / scale, bins = samples.length;
  return { center: [.5, .5], step, bins, heights: Float32Array.from({ length: GLIDE_SECTORS * bins }, (_, i) => samples[i % bins]!),
    caps: new Float64Array(GLIDE_SECTORS).fill(step * bins),
    distances: Float64Array.from({ length: GLIDE_SECTORS * (bins + 1) }, (_, i) => i % (bins + 1) * step * scale), minScale: scale, maxScale: scale, radius: step * bins, cells: bins };
}

// Independent feasibility oracle: check aircraft height at the most restrictive
// endpoint of every constant-height interval along a trial path, then bisect.
function reference(samples: number[], altitude: number, ratio: number, field?: number) {
  const feasible = (distance: number) => {
    if (field !== undefined && altitude - distance * FEET_PER_NM / ratio < field + 500) return false;
    for (let i = 0; i < samples.length && i * stepNm < distance; i++) {
      if (!Number.isFinite(samples[i])) return false;
      const flown = field === undefined ? Math.min(distance, (i + 1) * stepNm) : distance - i * stepNm;
      if (altitude - flown * FEET_PER_NM / ratio < (field === undefined ? Math.max(0, samples[i]!) : samples[i]!) + 200) return false;
    }
    return true;
  };
  let low = 0, high = samples.length * stepNm;
  for (let i = 0; i < 60; i++) { const middle = (low + high) / 2; if (feasible(middle)) low = middle; else high = middle; }
  return low;
}

test('forward and airport-return equations match an independent interval/path oracle without whole-bin rounding loss', () => {
  let seed = 7919;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let trial = 0; trial < 60; trial++) {
    const samples = Array.from({ length: 80 }, (_, i) => i < 8 ? 0 : trial % 3 === 0 ? 0 : Math.floor(random() * 7000));
    if (trial % 7 === 0) samples[20] = Infinity;
    for (const field of [undefined, 0, 1200]) {
      const altitude = 1500 + random() * 13000, ratio = 3 + random() * 17, prepared = profile(samples);
      const result = profileFootprint(prepared, altitude, ratio, field);
      const expected = reference(samples, altitude, ratio, field), actual = result.radii[0]! * scale / FEET_PER_NM;
      assert.ok(Math.abs(actual - expected) < 1e-8, `${trial}, field ${field}: ${actual} vs ${expected}`);
      // Conservative path-length increments must never expand the ideal path.
      for (let i = 0; i < prepared.distances.length; i++) prepared.distances[i]! *= 1.03;
      const conservative = profileFootprint(prepared, altitude, ratio, field).radii[0]! * scale / FEET_PER_NM;
      assert.ok(conservative <= expected + 1e-8);
    }
  }
});

test('missing terrain has an open forward boundary, while confirmed terrain/altitude limits draw a ring', () => {
  const samples = Array.from({ length: 80 }, (_, i) => i >= 15 ? Infinity : 0), prepared = profile(samples);
  const unknown = profileFootprint(prepared, 6500, 8);
  assert.equal(unknown.incomplete, true); assert.ok(unknown.radii.every(radius => radius > 0));
  assert.equal(ownshipOutline(prepared, unknown.radii, unknown.unknown).features.length, 0);
  const known = profileFootprint(profile(samples.map(value => Number.isFinite(value) ? value : 9000)), 6500, 8);
  assert.equal(known.incomplete, false); assert.ok(ownshipOutline(prepared, known.radii, known.unknown).features.length);
});

test('shared elevation pooling preserves whole-cell peaks and unknowns and obeys a byte budget', () => {
  const pool = new ElevationTilePool(65536), source = new Float32Array(65536).fill(100);
  source[3 * 256 + 3] = 9000; source[10 * 256 + 10] = NaN;
  const first = pool.maximum(source, 4);
  assert.equal(first[0], 9000); assert.ok(Number.isNaN(first[2 * 64 + 2]));
  assert.strictEqual(pool.maximum(source, 4), first); assert.equal(pool.sourceCells, 65536);
  for (let i = 0; i < 8; i++) pool.maximum(new Float32Array(65536).fill(i), 4);
  assert.ok(pool.byteLength <= 65536);
  assert.notStrictEqual(pool.maximum(source, 4), first, 'an evicted variant is rebuilt instead of retained by its weak source entry');
  pool.clear(); assert.equal(pool.byteLength, 0);
});

test('direct pooled mosaics match full-resolution maximum pooling, share work across origins and wrap at the date line', async () => {
  const tiles = new Map<string, Float32Array>(), pool = new ElevationTilePool();
  const read = async ({ z, x, y }: { z: number; x: number; y: number }) => {
    assert.ok(x >= 0 && x < 2 ** z);
    const key = `${z}/${x}/${y}`;
    let values = tiles.get(key);
    if (!values) {
      values = Float32Array.from({ length: 65536 }, (_, i) => i % 113 === 0 ? NaN : (i * 7919 + x * 37 + y * 11) % 10000);
      tiles.set(key, values);
    }
    return values;
  };
  for (const bounds of [[-.1, -.1, .1, .1], [179.9, -.1, 180.1, .1]] as [number, number, number, number][]) {
    const signal = new AbortController().signal, zoom = 11;
    const fine = await readElevationGrid(read, bounds, zoom, signal), expected = planningElevationGrid(fine, boundsViewport(bounds));
    const factor = fine.size / expected.size;
    const direct = await readElevationGrid(read, bounds, zoom, signal, undefined, { factor, tiles: pool });
    assert.deepEqual({ ...direct, values: undefined }, { ...expected, values: undefined });
    for (let y = 1; y < direct.height - 1; y++) for (let x = 1; x < direct.width - 1; x++) {
      assert.equal(direct.values[y * direct.width + x], expected.values[y * direct.width + x]);
    }
    const before = pool.sourceCells;
    const repeated = await readElevationGrid(read, bounds, zoom, signal, undefined, { factor, tiles: pool });
    assert.deepEqual(repeated, direct); assert.equal(pool.sourceCells, before);
    const layout = elevationGridLayout(bounds, zoom - Math.log2(factor)), mask = new Uint8Array(layout.width * layout.height); mask[0] = 1;
    const masked = await readElevationGrid(read, bounds, zoom, signal, mask, { factor, tiles: pool });
    assert.ok(masked.values.slice(1).every(Number.isNaN));
  }
});


test('sector distance increments bound numerical path integrals across headings and latitude', () => {
  for (const latitude of [-80, -35, 0, 35, 80]) {
    const center = project([0, latitude]), size = 32768, width = 512, height = 512;
    const x = Math.floor(center[0] * size) - 256, y = Math.floor(center[1] * size) - 256;
    const viewport: Point[] = [[x / size, y / size], [(x + width) / size, y / size], [(x + width) / size, (y + height) / size], [x / size, (y + height) / size]];
    const prepared = prepareGlideProfile(center, { size, x, y, width, height, values: new Float32Array(width * height) }, viewport, 80 / size);
    for (let sector = 0; sector < GLIDE_SECTORS; sector += 7) for (let bin = 0; bin < prepared.bins; bin += 5) {
      const bound = prepared.distances[sector * (prepared.bins + 1) + bin + 1]! - prepared.distances[sector * (prepared.bins + 1) + bin]!;
      for (const fraction of [0, .25, .5, .75, 1]) {
        const angle = (sector + fraction) / GLIDE_SECTORS * Math.PI * 2;
        let integral = 0;
        for (let i = 0; i < 100; i++) integral += nmPerWorldUnit(center[1] + (bin + (i + .5) / 100) * prepared.step * Math.sin(angle)) * prepared.step * FEET_PER_NM / 100;
        assert.ok(bound >= integral - 1e-8, `${latitude}, ${sector}, ${bin}: underestimated path length`);
        assert.ok(bound < integral * 1.002, 'local bounds should not inherit a whole-window latitude penalty');
      }
    }
  }
});

test('flat ground at high latitude keeps the expected physical glide distance and the horizontal safety inset', async () => {
  for (const latitude of [0, 35, 70, 80]) {
    const origin: Point = [0, latitude], center = project(origin), planner = new GlidePlanner(async () => new Float32Array(65536));
    // Test decreasing altitude too: retaining a larger work window must not
    // reintroduce its distance-scale penalty into a shorter glide.
    for (const [altitude, ratio] of [[18000, 20], [6500, 8]] as const) {
      const bounds: [number, number, number, number] = [-.1, latitude - .1, .1, latitude + .1];
      const result = await planner.calculate({ id: 1, viewport: boundsViewport(bounds), altitude, ratio, ownship: origin,
        airports: [], segments: [], sources: [], sourceKey: 'flat', base: '', tileUrl: '' }, new AbortController().signal);
      assert.equal(result.ownship!.incomplete, false); assert.equal(result.ownship!.line.features.length, 1);
      const ideal = (altitude - 200) * ratio / FEET_PER_NM;
      for (const coordinate of result.ownship!.area.features.flatMap(f => f.geometry.coordinates.flat(2))) {
        const point = project(coordinate as Point), radius = Math.hypot(point[0] - center[0], point[1] - center[1]);
        let distance = 0;
        for (let i = 0; i < 100; i++) distance += radius * nmPerWorldUnit(center[1] + (point[1] - center[1]) * (i + .5) / 100) / 100;
        assert.ok(distance <= ideal - .099 && distance > ideal - .3, `${latitude}°, ${altitude} ft: ${distance} vs ${ideal} NM`);
      }
    }
  }
});
