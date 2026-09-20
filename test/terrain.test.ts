import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeTerrarium, METERS_TO_FEET, paintTerrain } from '../src/layers/terrain/contours';
import { contourInterval, terrainDetail, terrainTileZoom } from '../src/layers/terrain/detail';
import { interpolateElevation, sampledHigh, simplifyElevation } from '../src/layers/terrain/grid';
import { TERRAIN_FILL_OPACITY } from '../src/layers/terrain/palette';
import { terrainIsolines, traceContours } from '../src/layers/terrain/isolines';
import { corridorDistance, corridorOpacity, nmPerWorldUnit, project, routeSegments, segmentsForTile,
  unproject, type Point, type Segment } from '../src/layers/terrain/geometry';
import { createRouteResolver } from '@zlayer/domain';
import type { FeatureCollectionResponse } from '@zlayer/contracts';

test('terrain distance and fade use nautical miles, rounded caps, and a union at turns', () => {
  const a = project([-122, 37]), b = project([-121, 37]);
  const segment: Segment = [a, b];
  const scale = nmPerWorldUnit(a[1]);
  for (const nm of [0, 4, 6, 8, 9]) {
    const p: Point = [a[0] - nm / scale, a[1]];
    assert.ok(Math.abs(corridorDistance(p, [segment]) - nm) < 1e-8);
  }
  assert.equal(corridorOpacity(0), 1);
  assert.equal(corridorOpacity(4), 1);
  assert.equal(corridorOpacity(6), 0.5);
  assert.equal(corridorOpacity(8), 0);
  assert.equal(corridorOpacity(9), 0);
  assert.equal(corridorDistance(a, [segment, [a, project([-122, 38])]]), 0);
  assert.equal(corridorOpacity(corridorDistance(a, [segment, segment])), 1);
});

test('corridor width accounts for latitude and works in both antimeridian world copies', () => {
  for (const latitude of [0, 37, 65]) {
    const a = project([-122, latitude]), b = project([-121, latitude]);
    assert.ok(Math.abs(corridorDistance([a[0] - 4 / nmPerWorldUnit(a[1]), a[1]], [[a, b]]) - 4) < 1e-8);
    const roundTrip = unproject(a);
    assert.ok(Math.abs(roundTrip[0] + 122) < 1e-8 && Math.abs(roundTrip[1] - latitude) < 1e-8);
  }
  const a = project([179.9, 0]), b = project([180.1, 0]);
  assert.equal(segmentsForTile({ z: 12, x: 0, y: 2048 }, [[a, b]]).length, 1);
  assert.equal(segmentsForTile({ z: 12, x: 4095, y: 2048 }, [[a, b]]).length, 1);
  assert.equal(segmentsForTile({ z: 12, x: 2048, y: 2048 }, [[a, b]]).length, 0);
});

test('terrain only follows displayed resolved legs and does not connect across an unresolved token', () => {
  const points: FeatureCollectionResponse = { type: 'FeatureCollection',
    features: ['AAAA', 'BBBB', 'CCCC'].map((ident, index) => ({ type: 'Feature', id: ident,
      geometry: { type: 'Point', coordinates: [index, 0] }, properties: { ident } })),
    meta: { layer: 'airports', revision: '2026-09-03', returned: 3, truncated: false } };
  const resolve = createRouteResolver([points]);
  assert.equal(routeSegments([resolve('AAAA BBBB')]).length, 1);
  assert.equal(routeSegments([resolve('AAAA MISSING BBBB')]).length, 0);
  assert.equal(routeSegments([resolve('AAAA')]).length, 0);
  assert.equal(routeSegments([]).length, 0);
});

test('Terrarium decoding preserves fractional and negative meters; transparent nodata is not sea level', () => {
  const heights = decodeTerrarium(new Uint8ClampedArray([128, 0, 0, 255, 128, 100, 128, 255,
    127, 255, 128, 255, 0, 0, 0, 0]));
  assert.equal(heights[0], 0);
  assert.ok(Math.abs(heights[1]! - 100.5 * METERS_TO_FEET) < 0.0001);
  assert.ok(Math.abs(heights[2]! + 0.5 * METERS_TO_FEET) < 0.0001);
  assert.ok(Number.isNaN(heights[3]));
});

test('native sampled highs survive sparse contour intervals; nodata and outside corridor stay transparent', () => {
  const tile = { z: 12, x: 660, y: 1595 }, size = 32;
  const a: Point = [(tile.x + 0.5) / 4096, tile.y / 4096];
  const b: Point = [a[0], (tile.y + 1) / 4096];
  const values = new Float32Array(size * size).fill(1200);
  values[10 * size + 10] = 2743;
  values[0] = NaN;
  const result = paintTerrain(values, tile, [[a, b]], 1000, 1, size);
  assert.equal(result.pixels[3], 0);
  assert.ok(result.pixels[4 * 20 + 3]! > 0 && result.pixels[4 * 20 + 3]! < 255);
  assert.equal(sampledHigh(values, tile, [[a, b]], size)?.elevation, 2743);
  assert.ok(paintTerrain(values, tile, [], 1000, 1, size).pixels.every(value => value === 0));
  assert.equal(contourInterval(10.99), 1000);
  assert.equal(contourInterval(11), 500);
});

test('contour fill has distinct 500/1000-foot bands and does not stack opacity at intersections', () => {
  const tile = { z: 12, x: 660, y: 1595 }, size = 8;
  const segment: Segment = [[660 / 4096, 1595 / 4096], [661 / 4096, 1596 / 4096]];
  const draw = (feet: number, segments = [segment]) => paintTerrain(new Float32Array(size * size).fill(feet), tile, segments, 500, 1, size).pixels;
  assert.notDeepEqual(draw(1000).slice(0, 3), draw(1500).slice(0, 3));
  assert.deepEqual(draw(1000), draw(1000, [segment, segment]));
});

test('sampled highs include terrain at and below sea level', () => {
  const tile = { z: 12, x: 660, y: 1595 }, size = 16;
  const segment: Segment = [[660 / 4096, 1595 / 4096], [661 / 4096, 1596 / 4096]];
  const values = new Float32Array(size * size).fill(-200);
  assert.equal(sampledHigh(values, tile, [segment], size)?.elevation, -200);
  values[0] = 0;
  assert.equal(sampledHigh(values, tile, [segment], size)?.elevation, 0);
  values.fill(NaN);
  assert.equal(sampledHigh(values, tile, [segment], size), undefined);
});

test('rendered fill keeps its core opacity and fades to transparent at eight nautical miles', () => {
  const tile = { z: 9, x: 256, y: 255 }, size = 256;
  const centerX = (tile.x + 0.5) / 512;
  const segment: Segment = [[centerX, tile.y / 512], [centerX, (tile.y + 1) / 512]];
  const pixels = paintTerrain(new Float32Array(size * size).fill(1200), tile, [segment], 1000, 1).pixels;
  const nmPerPixel = nmPerWorldUnit((tile.y + 128.5 / size) / 512) / 512 / size;
  const alpha = (nm: number) => pixels[(128 * size + Math.floor(127.5 + nm / nmPerPixel)) * 4 + 3]!;
  assert.equal(alpha(0), Math.round(255 * TERRAIN_FILL_OPACITY));
  assert.ok(alpha(0) >= 140, 'fill must be readily visible over a chart');
  assert.equal(alpha(3.5), alpha(0));
  assert.ok(alpha(6) / alpha(0) >= 0.46 && alpha(6) / alpha(0) <= 0.56);
  assert.equal(alpha(8.5), 0);
});

test('missing elevation only marks terrain incomplete where the rendered corridor has gaps', () => {
  const tile = { z: 9, x: 256, y: 255 }, size = 256;
  const centerX = (tile.x + 0.5) / 512;
  const segment: Segment = [[centerX, tile.y / 512], [centerX, (tile.y + 1) / 512]];
  // Flat lowlands still need known elevations even when their fill is unshaded.
  const values = new Float32Array(size * size);
  const draw = () => paintTerrain(interpolateElevation(simplifyElevation(values, size, 64), 64, size),
    tile, [segment], 1000, 1, size, false, true);
  values[128 * size] = NaN; // More than 20 NM from the route; never contributes to the corridor.
  assert.equal(draw().incomplete, false);
  for (const x of [128, 164]) { // Core and faded edge, respectively.
    values[128 * size + x] = NaN;
    const result = draw();
    assert.equal(result.incomplete, true);
    assert.equal(result.pixels[(128 * size + x) * 4 + 3], 0, 'unknown elevation stays transparent');
    values[128 * size + x] = 0;
  }
  assert.equal(draw().incomplete, false, 'complete corridor recovers even with nodata elsewhere');
  assert.equal(paintTerrain(values, tile, [], 1000, 1, size, false, true).incomplete, false);

  const coarse = new Float32Array(64 * 64);
  coarse[32 * 64 + 44] = NaN;
  const point: Point = [(tile.x + 44.5 / 64) / 512, (tile.y + 32.5 / 64) / 512];
  assert.ok(corridorDistance(point, [segment]) > 8);
  assert.equal(paintTerrain(interpolateElevation(coarse, 64, size), tile, [segment],
    1000, 1, size, false, true).incomplete, true, 'interpolation spreading a gap into the corridor still warns');
});

test('overview work stays bounded by screen size, while close views refine source and contour detail', () => {
  for (let zoom = 8; zoom <= 13; zoom++) {
    const detail = terrainDetail(zoom), tiles = 4 ** (detail.demZoom - zoom);
    assert.ok(tiles <= 4, 'a displayed tile must not fan out into hundreds of DEM reads');
    assert.ok(detail.gridSize <= 512);
    assert.equal(detail.lines, true, 'simplified overview regions still have visible contour outlines');
    assert.equal(detail.contourLabels === 0, zoom < 10);
  }
  assert.equal(terrainDetail(9).gridSize, 128);
  assert.equal(terrainDetail(9).demZoom, 10);
  assert.equal(terrainDetail(11).demZoom, 12);
  assert.equal(terrainDetail(11).interval, 500);
  assert.equal(terrainDetail(12).gridSize, 512);
  assert.equal(terrainTileZoom(10.6), 11, 'legend and label detail must match rounded MapLibre raster zoom');
});

test('zoom simplification preserves a narrow sampled ridge, its high-point position, and unknown cells', () => {
  const values = new Float32Array(16 * 16).fill(1200);
  values[5 * 16 + 6] = 5899;
  values[0] = NaN;
  const simplified = simplifyElevation(values, 16, 4);
  assert.equal(simplified[1 * 4 + 1], 5899, 'max pooling must not average away a narrow peak');
  assert.ok(Number.isNaN(simplified[0]), 'missing coverage must not become low terrain');
  assert.equal(simplified[15], 1200);
  assert.equal(simplifyElevation(values, 16, 16), values);
  const tile = { z: 12, x: 660, y: 1595 };
  const segment: Segment = [[660 / 4096, 1595 / 4096], [661 / 4096, 1596 / 4096]];
  const high = sampledHigh(values, tile, [segment], 16)!;
  assert.equal(high.elevation, 5899);
  assert.deepEqual(high.coordinate, unproject([(660 + 6.5 / 16) / 4096, (1595 + 5.5 / 16) / 4096]));
});

test('flat fill stays uniform and enabling contour outlines adds distinct ink', () => {
  const size = 64, values = Float32Array.from({ length: size * size }, (_, i) => 1100 + i % size * 100);
  const tile = { z: 12, x: 660, y: 1595 };
  const segment: Segment = [[660 / 4096, 1595 / 4096], [661 / 4096, 1596 / 4096]];
  const overview = paintTerrain(values, tile, [segment], 1000, 4, size, false);
  const detail = paintTerrain(values, tile, [segment], 1000, 4, size, true);
  assert.equal(overview.labels.length, 0);
  for (let i = 3; i < overview.pixels.length; i += 4) assert.equal(overview.pixels[i], Math.round(TERRAIN_FILL_OPACITY * 255));
  assert.notDeepEqual(overview.pixels, detail.pixels);
});

test('lowlands below the first contour stay unshaded instead of tinting the entire corridor', () => {
  const tile = { z: 12, x: 660, y: 1595 };
  const segment: Segment = [[660 / 4096, 1595 / 4096], [661 / 4096, 1596 / 4096]];
  const values = new Float32Array(16 * 16).fill(750);
  assert.ok(paintTerrain(values, tile, [segment], 1000, 1, 16, false).pixels.every(value => value === 0));
  assert.equal(paintTerrain(values, tile, [segment], 500, 1, 16, false).pixels[3], Math.round(TERRAIN_FILL_OPACITY * 255));
});

test('simplified geometry produces flat color regions, never blurred fill colors or varying core opacity', () => {
  const heights = interpolateElevation(new Float32Array([1100, 2900, 1100, 2900]), 2, 32);
  const tile = { z: 12, x: 660, y: 1595 };
  const segment: Segment = [[660 / 4096, 1595 / 4096], [661 / 4096, 1596 / 4096]];
  const result = paintTerrain(heights, tile, [segment], 1000, 1, 32, false);
  const colors = new Set<string>(), alphas = new Set<number>();
  for (let i = 0; i < result.pixels.length; i += 4) {
    colors.add([...result.pixels.slice(i, i + 3)].join(',')); alphas.add(result.pixels[i + 3]!);
  }
  assert.equal(colors.size, 2, 'only the 1,000–2,000 and 2,000–3,000 ft region colors may appear');
  assert.deepEqual([...alphas], [Math.round(TERRAIN_FILL_OPACITY * 255)]);
  const unknown = interpolateElevation(new Float32Array([NaN, 2000, NaN, 2000]), 2, 32);
  assert.ok(Number.isNaN(unknown[16 * 32 + 12]));
});

test('vector contours interpolate exact crossings, reach tile edges and join cells into paths', () => {
  const size = 16;
  const values = Float32Array.from({ length: size * size }, (_, i) => 500 + (i % size + 0.5) * 1000 / size);
  const paths = traceContours(values, size, 1000);
  assert.equal(paths.length, 1);
  assert.equal(paths[0]!.elevation, 1000);
  assert.ok(paths[0]!.points.every(([x]) => Math.abs(x - 0.5) < 1e-10));
  assert.deepEqual(paths[0]!.points.map(([, y]) => y).filter(y => y === 0 || y === 1).sort(), [0, 1]);
  const tile = { z: 12, x: 660, y: 1595 };
  const segment: Segment = [[660 / 4096, 1595 / 4096], [661 / 4096, 1596 / 4096]];
  const { lines } = terrainIsolines(values, size, tile, [segment], 1000, 256);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.opacity, 1);
  assert.equal(lines[0]!.coordinates.length, 1);
  assert.equal(lines[0]!.coordinates[0]!.length, 2, 'straight contours should simplify to two vertices');
});

test('vector contours preserve closed peaks and leave missing terrain open', () => {
  const size = 16;
  const values = Float32Array.from({ length: size * size }, (_, i) =>
    1800 - Math.hypot(i % size - 7.5, Math.floor(i / size) - 7.5) * 200);
  const closed = traceContours(values, size, 1000);
  assert.equal(closed.length, 1);
  assert.deepEqual(closed[0]!.points[0], closed[0]!.points.at(-1));
  for (let y = 0; y < size; y++) values[y * size + 8] = NaN;
  const broken = traceContours(values, size, 1000);
  assert.equal(broken.length, 2);
  for (const path of broken) assert.notDeepEqual(path.points[0], path.points.at(-1));
});

test('uneven saddles connect the same terrain regions as the bilinear fill', () => {
  const side = ([x, y]: Point) => x === 0 ? 'left' : x === 1 ? 'right' : y === 0 ? 'top' : 'bottom';
  for (const heights of [[1500, 0, 900, 1500], [500, 2000, 1100, 500]]) {
    const paths = traceContours(new Float32Array(heights), 2, 1000).filter(path => path.elevation === 1000);
    assert.deepEqual(paths.map(path => [side(path.points[0]!), side(path.points.at(-1)!)].sort().join('/')).sort(),
      ['bottom/left', 'right/top'], 'a center-average test would incorrectly join top/left and bottom/right');
  }
});

test('vector outlines retain core contrast and fade within the same route corridor as fills', () => {
  const size = 32, tile = { z: 9, x: 256, y: 255 };
  const x = (tile.x + 0.5) / 512;
  const segment: Segment = [[x, tile.y / 512], [x, (tile.y + 1) / 512]];
  const values = Float32Array.from({ length: size * size }, (_, i) => 500 + (Math.floor(i / size) + 0.5) * 1000 / size);
  const { lines } = terrainIsolines(values, size, tile, [segment], 1000, 512);
  assert.ok(lines.some(line => line.opacity === 1));
  assert.ok(lines.some(line => line.opacity > 0 && line.opacity < 0.5));
  assert.ok(lines.every(line => line.coordinates.every(path => path.length >= 2)));
  for (const line of lines) for (const path of line.coordinates) for (const point of path) {
    assert.ok(corridorDistance(project(point), [segment]) < 8.2, 'faded outlines must stay within the outer corridor');
  }
  assert.deepEqual(terrainIsolines(values, size, tile, [], 1000, 512).lines, []);
});
