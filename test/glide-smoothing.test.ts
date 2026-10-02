import assert from 'node:assert/strict';
import test from 'node:test';
import clipping, { type Polygon, type MultiPolygon } from 'polygon-clipping';
import { nmPerWorldUnit, project, type Point } from '../src/core/geo/route-corridor';
import type { ElevationGrid } from '../src/core/terrain/elevation';
import { FEET_PER_NM } from '../src/layers/glide/airports';
import { planningCellFactor, GLIDE_CELL_NM } from '../src/layers/glide/sampling';
import { planningElevationGrid } from './helpers/glide';
import { GLIDE_SECTORS, prepareGlideProfile, profileFootprint } from '../src/layers/glide/profile';
import { glideBoundary, glideSectorPaths, simplifyGlidePath, GLIDE_INSET_NM } from '../src/layers/glide/outline';
import { ownshipOutline } from '../src/layers/glide/geometry';
import { insideViewport } from '../src/layers/glide/coverage';

const scale = nmPerWorldUnit(.5) * FEET_PER_NM;
const worldNm = (nm: number) => nm * FEET_PER_NM / scale;
const center: Point = [.5, .5];
const viewport: Point[] = [[.498, .498], [.502, .498], [.502, .502], [.498, .502]];
function grid(sample: (x: number, y: number) => number): ElevationGrid {
  const size = 256 * 2 ** 11, width = 512, height = 512, x = size / 2 - width / 2, y = x;
  return { size, x, y, width, height, values: Float32Array.from({ length: width * height }, (_, i) => sample(i % width - 256, Math.floor(i / width) - 256)) };
}
function stepped(radii: number[]): Polygon {
  const ring: Point[] = [];
  for (let i = 0; i < radii.length; i++) for (const edge of [i, i + 1]) {
    const angle = edge / radii.length * Math.PI * 2;
    ring.push([center[0] + Math.cos(angle) * radii[i]!, center[1] + Math.sin(angle) * radii[i]!]);
  }
  ring.push(ring[0]!); return [ring];
}
function area(polygons: MultiPolygon): number {
  return polygons.reduce((sum, polygon) => sum + polygon.reduce((sum, ring, i) => {
    // Translate before shoelace to avoid cancellation at tiny world coordinates.
    const [ox, oy] = ring[0]!;
    const area = Math.abs(ring.slice(1).reduce((total, point, j) => {
      const previous = ring[j]!;
      return total + (previous[0] - ox) * (point[1] - oy) - (point[0] - ox) * (previous[1] - oy);
    }, 0)) / 2;
    return sum + (i ? -area : area);
  }, 0), 0);
}

test('planning cells retain a one-pixel summit and preserve unknown cells instead of averaging them away', () => {
  const fine = grid((x, y) => x === 8 && y === 8 ? 8500 : x === 24 && y === 8 ? NaN : 100);
  const factor = planningCellFactor(fine), coarse = planningElevationGrid(fine, viewport);
  assert.equal(factor, 4);
  assert.equal(coarse.values.length, fine.values.length / 16);
  const cellNm = nmPerWorldUnit(.5) / coarse.size;
  assert.ok(cellNm >= GLIDE_CELL_NM && cellNm < GLIDE_CELL_NM * 2);
  const at = (x: number, y: number) => coarse.values[(Math.floor((fine.y + 256 + y) / factor) - coarse.y) * coarse.width + Math.floor((fine.x + 256 + x) / factor) - coarse.x];
  assert.equal(at(8, 8), 8500); assert.ok(Number.isNaN(at(24, 8)));
  assert.equal(at(16, 8), 100);
  const polar = grid(() => 100); polar.y = Math.round(polar.size * .2);
  assert.ok(planningCellFactor(polar) > factor, 'physical planning scale also holds at high latitudes');
});

test('coarser whole-cell profiles remain conservative for isolated peaks, ridges and unknown strips', () => {
  const fixtures = [
    grid((x, y) => x === 35 && y === 1 ? 9000 : 0),
    grid((x, y) => x >= 35 && x <= 40 && y >= -30 && y <= 70 ? 3000 : 0),
    grid(x => x >= 35 && x <= 40 ? NaN : 0),
  ];
  for (const fine of fixtures) {
    const coarse = planningElevationGrid(fine, viewport), radius = worldNm(9);
    const fineProfile = prepareGlideProfile(center, fine, viewport, radius);
    const coarseProfile = prepareGlideProfile(center, coarse, viewport, radius);
    assert.ok(coarseProfile.cells < fineProfile.cells / 12);
    assert.ok(coarseProfile.heights.length < fineProfile.heights.length / 3);
    for (const field of [undefined, 0]) {
      const before = profileFootprint(fineProfile, 6500, 8, field);
      const after = profileFootprint(coarseProfile, 6500, 8, field);
      for (let i = 0; i < GLIDE_SECTORS; i++) assert.ok(after.radii[i]! <= before.radii[i]! + 1e-12, `sector ${i} expanded across terrain`);
      if (before.incomplete) assert.equal(after.incomplete, true);
    }
  }
});

test('smoothing and simplification stay inside the proven region across sharp notches, alternating peaks and the bearing seam', () => {
  let seed = 137;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let trial = 0; trial < 80; trial++) {
    const radii = Array.from({ length: GLIDE_SECTORS }, (_, i) => worldNm(trial % 3 === 0 ? 6 + (i % 2) * .35 : 1 + random() * 8));
    radii[trial % GLIDE_SECTORS] = 0; radii[0] = worldNm(.1);
    const sectorPaths = glideSectorPaths(center, radii, scale);
    const boundary = glideBoundary(center, radii, scale);
    const smooth = simplifyGlidePath(boundary, scale, GLIDE_SECTORS / 4);
    const excess = clipping.difference([smooth], stepped(radii));
    assert.ok(area(excess) < 1e-18, `trial ${trial} added reachable area`);
    assert.deepEqual(smooth[0], smooth.at(-1));
    for (let i = 0; i < GLIDE_SECTORS; i++) {
      const point = sectorPaths[i]![0]!, previous = radii[(i + GLIDE_SECTORS - 1) % GLIDE_SECTORS]!;
      assert.ok(Math.hypot(point[0] - center[0], point[1] - center[1]) <= Math.max(0, Math.min(radii[i]!, previous) - worldNm(GLIDE_INSET_NM)) + 1e-12);
    }
  }
});

test('flat and finely serrated contours lose redundant vertices while retaining the 0.1 NM inset', t => {
  for (const noisy of [false, true]) {
    const radii = Array.from({ length: GLIDE_SECTORS }, (_, i) => worldNm(7 + (noisy ? i % 2 * .12 : 0)));
    const outline = simplifyGlidePath(glideBoundary(center, radii, scale), scale, GLIDE_SECTORS / 4);
    assert.ok(outline.length < 50, `too many retained vertices: ${outline.length}`);
    const maxRadius = Math.max(...outline.map(p => Math.hypot(p[0] - center[0], p[1] - center[1]))) / worldNm(1);
    assert.ok(maxRadius <= 7 - GLIDE_INSET_NM + 1e-8);
    assert.ok(area([[outline]]) > area([stepped(radii)]) * .93, 'smoothing should not throw away a large flat-ground area');
    t.diagnostic(`${noisy ? 'Serrated' : 'Flat'} contour: ${2 * GLIDE_SECTORS + 1} sector-step vertices → ${outline.length}`);
  }
});

test('a clear sector keeps its long valley tip without expanding into adjacent blocked sectors', () => {
  const radii = Array.from({ length: GLIDE_SECTORS }, () => worldNm(2));
  for (const sector of [0, 7, GLIDE_SECTORS - 1]) {
    const isolated = [...radii]; isolated[sector] = worldNm(8);
    const outline = simplifyGlidePath(glideBoundary(center, isolated, scale), scale, GLIDE_SECTORS / 4);
    const reach = Math.max(...outline.map(p => Math.hypot(p[0] - center[0], p[1] - center[1]))) / worldNm(1);
    assert.ok(reach > 7.7 && reach < 7.9, `isolated sector ${sector} was erased or lost its margins: ${reach}`);
    assert.ok(area(clipping.difference([outline], stepped(isolated))) < 1e-18, 'valley tip crossed its proven sector boundary');
  }
});

test('rotated mountain valleys retain long forward and airport-return lobes after smoothing', t => {
  const altitude = 6500, ratio = 8, widthNm = .8;
  const cellNm = nmPerWorldUnit(.5) / (256 * 2 ** 11);
  const reaches: number[] = [];
  for (const degrees of [0, .5, 1.5, 12, 30, 44, 89.5, 180, 271.5, 359.5]) {
    const angle = degrees * Math.PI / 180, cosine = Math.cos(angle), sine = Math.sin(angle);
    const local = (p: Point): Point => {
      const x = (p[0] - .5) / worldNm(1), y = (p[1] - .5) / worldNm(1);
      return [x * cosine + y * sine, -x * sine + y * cosine];
    };
    const fine = grid((x, y) => {
      const east = (x + .5) * cellNm, south = (y + .5) * cellNm;
      return east * cosine + south * sine > 2 && Math.abs(-east * sine + south * cosine) > widthNm / 2 ? 9000 : 0;
    });
    const profile = prepareGlideProfile(center, planningElevationGrid(fine, viewport), viewport, worldNm(10));
    for (const field of [undefined, 0]) {
      const result = profileFootprint(profile, altitude, ratio, field), ring = result.polygon[0]!;
      const ideal = (altitude - (field === undefined ? 200 : 500)) * ratio / FEET_PER_NM;
      const along = Math.max(...ring.map(p => local(p)[0]));
      reaches.push(along);
      assert.equal(result.incomplete, false);
      assert.ok(along > ideal - .6 && along < ideal - GLIDE_INSET_NM, `${degrees}°, field ${field}: valley reach ${along} NM vs ${ideal}`);
      // Check the entire simplified perimeter, including shortcuts between tips.
      // Beyond the valley entrance, every point must stay between its walls.
      for (let i = 1; i < ring.length; i++) for (let sample = 0; sample <= 20; sample++) {
        const a = ring[i - 1]!, b = ring[i]!, fraction = sample / 20;
        const [along, across] = local([a[0] + fraction * (b[0] - a[0]), a[1] + fraction * (b[1] - a[1])]);
        if (along > 2) assert.ok(Math.abs(across) <= widthNm / 2, `${degrees}° outline crossed a valley wall`);
      }
      assert.ok(ring.length < 100, 'valley geometry remains compact');
    }
  }
  t.diagnostic(`Smoothed valley reach across headings/directions: ${Math.min(...reaches).toFixed(2)}–${Math.max(...reaches).toFixed(2)} NM`);
});

test('valley lobes stop at a crossing ridge or unknown strip instead of reaching low ground behind it', () => {
  const cellNm = nmPerWorldUnit(.5) / (256 * 2 ** 11);
  for (const obstruction of [9000, NaN]) {
    const fine = grid((x, y) => {
      const along = (x + .5) * cellNm, across = (y + .5) * cellNm;
      if (along > 4 && along < 4.3) return obstruction;
      return along > 2 && Math.abs(across) > .4 ? 9000 : 0;
    });
    const profile = prepareGlideProfile(center, planningElevationGrid(fine, viewport), viewport, worldNm(10));
    for (const field of [undefined, 0]) {
      const result = profileFootprint(profile, 6500, 8, field);
      const reach = Math.max(...result.polygon[0]!.map(p => (p[0] - .5) / worldNm(1)));
      assert.ok(reach > 3 && reach < 4, `crossing obstruction was skipped: ${reach}`);
      assert.equal(result.incomplete, Number.isNaN(obstruction));
    }
  }
});

test('ownship smoothing never bridges zero-radius or viewport-limited sectors', () => {
  const profile = prepareGlideProfile(center, grid(() => 0), viewport, worldNm(9));
  assert.equal(ownshipOutline(profile, Array.from({ length: GLIDE_SECTORS }, () => worldNm(.05))).features.length, 0, 'a range entirely consumed by the inset has no drawable ring');
  const radii = Array.from({ length: GLIDE_SECTORS }, () => worldNm(6));
  radii[30] = profile.caps[30]!; radii[80] = 0;
  const lines = ownshipOutline(profile, radii);
  assert.ok(lines.features.length);
  for (const line of lines.features[0]!.geometry.coordinates) {
    assert.notDeepEqual(line[0], line.at(-1));
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1]!, b = line[i]!;
      // Test the longitude/latitude path after projecting it back into world space.
      const p = project(a as Point), q = project(b as Point);
      for (const t of [.1, .5, .9]) {
        const point: Point = [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])];
        if (Math.hypot(point[0] - .5, point[1] - .5) < 1e-12) continue;
        const angle = (Math.atan2(point[1] - .5, point[0] - .5) + 2 * Math.PI) % (2 * Math.PI);
        const sector = Math.floor(angle / (2 * Math.PI) * GLIDE_SECTORS);
        assert.ok(sector !== 30 && sector !== 80, `line bridged excluded sector ${sector}`);
        assert.ok(insideViewport(point, viewport));
      }
    }
  }
});

test('coarsened cells at narrow and rotated viewport edges do not create false terrain-gap warnings', () => {
  for (const angle of [0, .4, 1.1, Math.PI / 2]) {
    const rotate = ([x, y]: Point): Point => [center[0] + x * Math.cos(angle) - y * Math.sin(angle), center[1] + x * Math.sin(angle) + y * Math.cos(angle)];
    const view: Point[] = [[-.00012, -.00036], [.00012, -.00036], [.00012, .00036], [-.00012, .00036]].map(p => rotate(p as Point));
    const fine = grid((x, y) => insideViewport([.5 + (x + .5) / (256 * 2 ** 11), .5 + (y + .5) / (256 * 2 ** 11)], view) ? 0 : NaN);
    const coarse = planningElevationGrid(fine, view);
    for (const offset of [-.00008, 0, .00008]) {
      const origin = rotate([offset, 0]);
      const profile = prepareGlideProfile(origin, coarse, view, worldNm(20));
      const footprint = profileFootprint(profile, 18000, 20);
      assert.equal(footprint.incomplete, false, `false missing terrain at rotation ${angle}, offset ${offset}`);
      assert.equal(ownshipOutline(profile, footprint.radii).features.length, 0, 'camera caps stay invisible');
      assert.ok(footprint.radii.some(r => r > 0));
      for (const p of footprint.polygon[0]!) assert.ok(insideViewport(p, view));
    }
  }
});
