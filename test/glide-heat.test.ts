import assert from 'node:assert/strict';
import test from 'node:test';
import clipping, { type MultiPolygon } from 'polygon-clipping';
import type { Bounds } from '@zlayer/contracts';
import { project, unproject, type Point, type Segment } from '../src/core/geo/route-corridor';
import type { LandingHeat, LandingHeatFrame } from '../src/layers/glide/landing-heat';
import { composeLandingHeatCells as composeLandingHeat, composeLandingDensity } from '../src/layers/glide/landing-heat-composition';
import { landingHeatPyramid } from '../src/layers/glide/landing-heat-tiles';

const step = 2 ** -14;
const frame: LandingHeatFrame = { left: .5, top: .5, step, width: 4, height: 3 };
const route: Segment[] = [[project([-1, 0]), project([1, 0])]];
const rectangle = ([w, n, e, s]: Bounds): MultiPolygon => [[[[w, n], [e, n], [e, s], [w, s], [w, n]]]];
const bounds = ([w, n, e, s]: Bounds): Bounds => {
  const a = unproject([w, n]), b = unproject([e, s]); return [a[0], b[1], b[0], a[1]];
};
const grid = (extent: Bounds, cells: number[], width: number, density = false): LandingHeat =>
  ({ extent, width, height: cells.length / width / (density ? 3 : 1), cells: Uint8Array.from(cells), flags: 0, density });

/** Independent geometry oracle: union the source-pixel rectangles above each
 * density threshold, then measure intersections with output cells. Coordinates
 * are in output-cell units so polygon area arithmetic stays well-conditioned. */
function reference(heats: LandingHeat[], clip: MultiPolygon = rectangle([0, 0, 4, 3])) {
  const bands: { polygon: MultiPolygon; values: number[] }[] = [];
  for (const heat of heats) {
    const [w, n, e, s] = heat.extent, shift = Math.round(frame.left - w);
    for (let y = 0; y < heat.height; y++) for (let x = 0; x < heat.width; x++) {
      const i = y * heat.width + x, tier = heat.cells[i]!;
      const green = heat.density ? heat.cells[i * 3]! : tier === 2 ? 255 : 0;
      const total = heat.density ? green + heat.cells[i * 3 + 1]! : tier ? 255 : 0;
      if (!total) continue;
      bands.push({ polygon: clipping.intersection(rectangle([
        (w + shift + x * (e - w) / heat.width - frame.left) / step,
        (n + y * (s - n) / heat.height - frame.top) / step,
        (w + shift + (x + 1) * (e - w) / heat.width - frame.left) / step,
        (n + (y + 1) * (s - n) / heat.height - frame.top) / step,
      ]), clip), values: [total, green] });
    }
  }
  const area = (polygons: MultiPolygon) => polygons.reduce((sum, polygon) => sum + polygon.reduce((sum, ring, index) => {
    let area = 0;
    for (let i = 1; i < ring.length; i++) area += ring[i - 1]![0] * ring[i]![1] - ring[i]![0] * ring[i - 1]![1];
    return sum + Math.abs(area) / 2 * (index ? -1 : 1);
  }, 0), 0);
  const unions = [0, 1].map(channel => {
    const levels = [...new Set(bands.map(band => band.values[channel]!).filter(Boolean))].sort((a, b) => a - b);
    return levels.map((level, i) => {
      const polygons = bands.filter(band => band.values[channel]! >= level).flatMap(band => band.polygon);
      return { value: level - (levels[i - 1] ?? 0), polygons: polygons.length ? clipping.union(polygons[0]!, ...polygons.slice(1)) : [] };
    });
  });
  const result = new Uint8ClampedArray(4 * 3 * 4);
  for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) {
    const cell = rectangle([x, y, x + 1, y + 1]);
    const [covered, preferred] = unions.map(bands => bands.reduce((sum, band) => sum + band.value * area(clipping.intersection(band.polygons, cell)), 0));
    if (!covered) continue;
    result.set([...(preferred! > covered / 2 + 1e-10 ? [83, 229, 45] : [162, 59, 255]), Math.round(64 + 160 * Math.sqrt(covered / 255))], (y * 4 + x) * 4);
  }
  return result;
}

test('area composition matches geometric unions across fractions, overlap, holes and world copies', () => {
  const a = grid([.5, .5, .5 + 3 * step, .5 + 3 * step], [2, 0, 1, 0, 1, 2, 1, 2, 0], 3);
  const b = grid([.5 + step / 3, .5 + step / 5, .5 + 4 * step, .5 + 2.5 * step], [64, 64, 255, 128, 0, 255, 0, 128, 255, 0, 0, 255], 2, true);
  const copy = { ...a, extent: a.extent.map((n, i) => i % 2 ? n : n + 1) as Bounds };
  for (const heats of [[a], [b], [a, b], [a, b, copy], [b, copy, a]]) {
    assert.deepEqual(composeLandingHeat(heats, frame, route).rgba, reference(heats));
  }
});

test('regional scope and holes restrict the integrated field without borrowing another world copy', () => {
  const extent: Bounds = [.5, .5, .5 + 4 * step, .5 + 3 * step];
  const hole: Bounds = [.5 + step, .5 + step, .5 + 3 * step, .5 + 2 * step];
  const heat = grid(extent, [128, 0, 255], 1, true);
  heat.scope = { include: [{ id: 'sample', bounds: [bounds(extent)] }], exclude: [{ id: 'hole', bounds: [bounds(hole)] }] };
  const clip = clipping.difference(rectangle([0, 0, 4, 3]), rectangle([1, 1, 3, 2]));
  assert.deepEqual(composeLandingHeat([heat], frame, route).rgba, reference([heat], clip));
  const wrapped = { ...frame, left: frame.left - 1 };
  assert.deepEqual(composeLandingHeat([heat], wrapped, route.map(s => s.map(([x, y]) => [x - 1, y] as Point) as Segment)).rgba, reference([heat], clip));
});

test('every sparse source pixel survives zoom-out, with its area fraction and tier intact', () => {
  for (const density of [false, true]) for (const tier of [1, 2]) for (const offset of [0, 1, 4, 7, 19]) {
    const cells = new Uint8Array(256 * 256 * (density ? 3 : 1)), at = 4 * 256 + offset;
    if (density) { cells[at * 3 + (tier === 2 ? 0 : 1)] = 255; cells[at * 3 + 2] = 255; }
    else cells[at] = tier;
    const heat: LandingHeat = { extent: [.5, .5, .5 + 1 / 256, .5 + 1 / 256], width: 256, height: 256, cells, density, flags: 0 };
    const densityGrid = composeLandingDensity([heat], { left: .5, top: .5, width: 256, height: 256, step: 1 / 65536 }, route);
    for (const image of landingHeatPyramid(densityGrid)) {
      assert.ok(image.shadedCells > 0, `${density ? 'numeric' : 'legacy'} tier ${tier}, pixel ${offset}, level ${image.width}`);
      const first = image.rgba.findIndex((_, i) => i % 4 === 3 && image.rgba[i]! > 0) - 3;
      assert.deepEqual([...image.rgba.slice(first, first + 3)], tier === 2 ? [83, 229, 45] : [162, 59, 255]);
    }
  }
  const heat = grid([.5, .5, .5 + step / 16, .5 + step / 16], [255, 0, 255], 1, true);
  assert.equal(composeLandingHeat([heat], frame, route).rgba[3], 74, '1/256 covered area uses sqrt(1/256), not one full point hit');
});
