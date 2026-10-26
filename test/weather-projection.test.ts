import assert from 'node:assert/strict';
import test from 'node:test';
import proj4 from 'proj4';
import type { AwcGridManifest } from '@zlayer/contracts';
import type { LambertGrid } from '../src/layers/weather-awc/grids/grib';
import { samplingMap, windRotation } from '../src/layers/weather-awc/grids/conversion';
import { randomSequence, type Point } from './helpers/weather-geometry';

const grids: LambertGrid[] = [
  [38.5, 38.5, -97.5, 3000], [25, 25, -95, 3000], [30, 60, -100, 4000],
  [60, 30, -100, 4000], [20, 50, -105, 3500], [45, 45, -95, 5000],
].map(([parallel1, parallel2, meridian, spacing]) => ({ width: 1500, height: 1000, latitude: 21, longitude: -125,
  originLatitude: 38, meridian: meridian!, parallel1: parallel1!, parallel2: parallel2!, dx: spacing!, dy: spacing!,
  gridRelative: true, signature: 'generated-qualified-Lambert' }));
grids.push({ ...grids[0]!, longitude: 179, meridian: 179, width: 300, height: 200, dx: 20_000, dy: 20_000 });
grids.push({ ...grids.at(-1)!, longitude: -179 });

function referenceProjection(grid: LambertGrid) {
  const projection = proj4('+proj=longlat +a=6371229 +b=6371229 +no_defs',
    `+proj=lcc +lat_1=${grid.parallel1} +lat_2=${grid.parallel2} +lat_0=${grid.originLatitude} +lon_0=${grid.meridian} +a=6371229 +b=6371229 +units=m +no_defs`);
  const origin = projection.forward<Point>([grid.longitude, grid.latitude]);
  return { projection, origin };
}

test('generated Lambert grids choose the same source cells as independent Proj4 transforms', () => {
  const target: AwcGridManifest['grid'] = { projection: 'EPSG:3857', width: 83, height: 57, bounds: [-130, 20, -60, 55] };
  const mercator = proj4('EPSG:4326', 'EPSG:3857');
  const southwest = mercator.forward<Point>([target.bounds[0], target.bounds[1]]), northeast = mercator.forward<Point>([target.bounds[2], target.bounds[3]]);
  for (const grid of grids) {
    const { projection, origin } = referenceProjection(grid), indices = samplingMap(grid, target);
    let covered = 0, outside = 0;
    for (let y = 0; y < target.height; y++) for (let x = 0; x < target.width; x++) {
      const position = mercator.inverse<Point>([southwest[0] + (x + .5) / target.width * (northeast[0] - southwest[0]),
        northeast[1] - (y + .5) / target.height * (northeast[1] - southwest[1])]);
      const projected = projection.forward(position);
      const column = Math.floor((projected[0] - origin[0]) / grid.dx + .5), row = Math.floor((projected[1] - origin[1]) / grid.dy + .5);
      const expected = column >= 0 && column < grid.width && row >= 0 && row < grid.height ? row * grid.width + column : -1;
      assert.equal(indices[y * target.width + x], expected, `parallels ${grid.parallel1}/${grid.parallel2}, target ${x}/${y}`);
      if (expected < 0) outside++; else covered++;
    }
    assert.ok(covered > 0 && outside > 0, 'exercise source coverage edges as well as its interior');
  }
});

test('wind rotation agrees with independent projected cell directions and conserves speed within output rounding', () => {
  const random = randomSequence(9103);
  for (const grid of grids) {
    const { projection, origin } = referenceProjection(grid);
    const indices = Int32Array.from({ length: 100 }, () => Math.floor(random() * grid.width * grid.height));
    const east = Float32Array.from(indices, () => random() * 160 - 80), north = Float32Array.from(indices, () => random() * 160 - 80);
    const u = east.slice(), v = north.slice();
    windRotation(grid, indices)(east, north);
    for (const [i, index] of indices.entries()) {
      const x = origin[0] + index % grid.width * grid.dx, y = origin[1] + Math.floor(index / grid.width) * grid.dy;
      const at = projection.inverse<Point>([x, y]), scale = Math.cos(at[1] * Math.PI / 180);
      // Central differences in Proj4's inverse supply the local axis directions
      // independently of our analytic meridian-convergence formula.
      const direction = (dx: number, dy: number): Point => {
        const a = projection.inverse<Point>([x - dx, y - dy]), b = projection.inverse<Point>([x + dx, y + dy]);
        const east = (b[0] - a[0]) * scale, north = b[1] - a[1], length = Math.hypot(east, north);
        return [east / length, north / length];
      };
      const eastward = direction(.5, 0), northward = direction(0, .5);
      assert.ok(Math.abs(east[i]! - (u[i]! * eastward[0] + v[i]! * northward[0])) <= .05002);
      assert.ok(Math.abs(north[i]! - (u[i]! * eastward[1] + v[i]! * northward[1])) <= .05002);
      assert.ok(Math.abs(Math.hypot(east[i]!, north[i]!) - Math.hypot(u[i]!, v[i]!)) <= Math.SQRT2 * .05002);
    }
  }
});
