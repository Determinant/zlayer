import assert from 'node:assert/strict';
import test from 'node:test';
import { distanceToSegment, project, type Point, type Segment } from '../src/layers/terrain/geometry';
import { smoothContour, terrainIsolines, traceContours } from '../src/layers/terrain/isolines';

function distanceToPath(point: Point, path: Point[]): number {
  return Math.min(...path.slice(1).map((end, i) => distanceToSegment(point, [path[i]!, end])));
}

function sharpestTurn(points: Point[]): number {
  let sharpest = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1]!, b = points[i]!, c = points[i + 1]!;
    const dx = b[0] - a[0], dy = b[1] - a[1], ex = c[0] - b[0], ey = c[1] - b[1];
    const length = Math.hypot(dx, dy) * Math.hypot(ex, ey);
    if (length > 0) sharpest = Math.max(sharpest, Math.acos(Math.max(-1, Math.min(1, (dx * ex + dy * ey) / length))));
  }
  return sharpest;
}

test('contour interpolation rounds stair steps with bounded movement, work and fixed open ends', () => {
  const points: Point[] = [[0, 0], [10, 0], [10, 10], [20, 10], [20, 20], [30, 20]];
  const original = structuredClone(points), maxCut = 0.5;
  const rounded = smoothContour(points, maxCut);
  assert.deepEqual(points, original, 'cached inputs must not be mutated');
  assert.deepEqual(rounded[0], points[0]);
  assert.deepEqual(rounded.at(-1), points.at(-1));
  assert.ok(rounded.length <= points.length * 4, 'work is bounded by the path, not the grid area');
  assert.ok(sharpestTurn(rounded) < sharpestTurn(points) / 2);
  for (const point of rounded) assert.ok(distanceToPath(point, points) <= 2 * maxCut);
  for (const point of points) assert.ok(distanceToPath(point, rounded) <= 2 * maxCut);
  for (const point of points.slice(1, -1)) assert.ok(distanceToPath(point, rounded) > 0.1, 'corners actually round off');
});

test('contour interpolation preserves closed peaks, tiny paths and coincident crossings', () => {
  const peak: Point[] = [[0, 0.5], [0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]];
  const rounded = smoothContour(peak, 0.5 / 512);
  assert.deepEqual(rounded[0], rounded.at(-1));
  assert.ok(rounded.length <= peak.length * 4);
  assert.ok(rounded.every(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1));
  assert.ok(sharpestTurn(rounded) < sharpestTurn(peak));
  const short: Point[] = [[0, 0], [1, 1]];
  assert.equal(smoothContour(short, 0.01), short);
  assert.deepEqual(smoothContour([], 0.01), []);
  assert.ok(smoothContour([[0, 0], [0, 0], [0.5, 0], [1, 1]], 0.01)
    .every(point => point.every(Number.isFinite)));
});

test('published contours keep rounded grid corners after simplification and retain tile endpoints', () => {
  const size = 8, displaySize = 256, tile = { z: 13, x: 1320, y: 3190 }, scale = 2 ** tile.z;
  const values = Float32Array.from({ length: size * size }, (_, i) =>
    i % size < 2 + Math.floor(Math.floor(i / size) / 2) ? 500 : 2500);
  const original = values.slice();
  const segments: Segment[] = [[[tile.x / scale, tile.y / scale], [(tile.x + 1) / scale, (tile.y + 1) / scale]]];
  const traced = traceContours(values, size, 1000);
  const { lines } = terrainIsolines(values, size, tile, segments, 1000, displaySize);
  assert.equal(lines.length, 2);
  for (const line of lines) {
    const raw = traced.find(path => path.elevation === line.elevation)!.points;
    assert.equal(line.coordinates.length, 1);
    const path = line.coordinates[0]!.map(point => {
      const [x, y] = project(point);
      return [x * scale - tile.x, y * scale - tile.y] as Point;
    });
    assert.ok(sharpestTurn(path) < sharpestTurn(raw) * 0.8, 'separated contours must retain rounded corners');
    assert.ok(Math.hypot(path[0]![0] - raw[0]![0], path[0]![1] - raw[0]![1]) < 1e-10);
    assert.ok(Math.hypot(path.at(-1)![0] - raw.at(-1)![0], path.at(-1)![1] - raw.at(-1)![1]) < 1e-10);
    for (const point of path) assert.ok(distanceToPath(point, raw) * size < 0.25);
  }
  assert.deepEqual(values, original, 'display smoothing must not change elevations');
});

test('close-zoom contours remove square-grid elbows while reducing rendered vertices', () => {
  const size = 256, tile = { z: 13, x: 1320, y: 3190 }, scale = 2 ** tile.z;
  // A coarser geographic grid repeats heights across several Mercator samples.
  const values = Float32Array.from({ length: size * size }, (_, i) =>
    250 + 35 * Math.floor((i % size) / 4) + 50 * Math.floor(Math.floor(i / size) / 4));
  const segments: Segment[] = [[[tile.x / scale, tile.y / scale], [(tile.x + 1) / scale, (tile.y + 1) / scale]]];
  const raw = traceContours(values, size, 1000, false);
  const { lines } = terrainIsolines(values, size, tile, segments, 1000, 512, false);
  assert.deepEqual(lines.map(line => line.elevation), [1000, 2000, 3000, 4000, 5000]);
  let vertices = 0;
  for (const line of lines) {
    assert.equal(line.coordinates.length, 1, 'each contour remains one continuous path');
    const path = line.coordinates[0]!.map(point => {
      const [x, y] = project(point);
      return [x * scale - tile.x, y * scale - tile.y] as Point;
    });
    assert.ok(path.length > 2, 'each contour retains enough vertices to check rounding');
    vertices += path.length;
    assert.ok(sharpestTurn(path) < Math.PI / 4, 'square elbows must remain rounded after simplification');
    const original = raw.find(path => path.elevation === line.elevation)!.points;
    for (const point of path) assert.ok(distanceToPath(point, original) * size < 1.5, 'rounding stays near the source contour');
  }
  assert.ok(vertices < raw.reduce((count, path) => count + path.points.length, 0) * 0.75);
});

test('subpixel peaks keep a closed contour after stronger simplification', () => {
  const size = 256, tile = { z: 13, x: 1320, y: 3190 }, scale = 2 ** tile.z;
  const values = new Float32Array(size * size).fill(999);
  values[128 * size + 128] = 1001;
  const segments: Segment[] = [[[tile.x / scale, tile.y / scale], [(tile.x + 1) / scale, (tile.y + 1) / scale]]];
  const { lines } = terrainIsolines(values, size, tile, segments, 1000, 512, false);
  assert.equal(lines.length, 1);
  const path = lines[0]!.coordinates[0]!;
  assert.ok(path.length >= 4);
  assert.deepEqual(path[0], path.at(-1));
  assert.ok(new Set(path.map(point => JSON.stringify(point))).size >= 3);
});

test('rounded contours do not bridge missing terrain or change saddle connectivity', () => {
  const size = 16;
  const values = Float32Array.from({ length: size * size }, (_, i) =>
    1800 - Math.hypot(i % size - 7.5, Math.floor(i / size) - 7.5) * 200);
  for (let y = 0; y < size; y++) values[y * size + 8] = NaN;
  const paths = traceContours(values, size, 1000);
  assert.equal(paths.length, 2);
  for (const { points } of paths) {
    const rounded = smoothContour(points, 0.5 / 512);
    assert.deepEqual(rounded[0], points[0]);
    assert.deepEqual(rounded.at(-1), points.at(-1));
    assert.notDeepEqual(rounded[0], rounded.at(-1));
    assert.ok(rounded.every(([x]) => x <= 7.5 / size || x >= 9.5 / size));
  }
  for (const { points } of traceContours(new Float32Array([1500, 0, 900, 1500]), 2, 1000)) {
    const rounded = smoothContour(points, 0.5 / 512);
    assert.deepEqual([rounded[0], rounded.at(-1)], [points[0], points.at(-1)]);
  }
});

test('crowded contours stay separate without disabling rounding on distant peaks', () => {
  const size = 256, tile = { z: 13, x: 1320, y: 3190 }, scale = 2 ** tile.z;
  // This patch previously produced two intersections between neighboring
  // elevations, although the original simplified paths did not intersect.
  const patch = [
    1468, 4637, 3009, 3691, 3468, 5899,
    2875, 1786, 5922, 4316, 3765, 2704,
    3608, 710, 5636, 4947, 58, 1162,
    3374, 106, 3372, 2851, 2724, 2654,
    117, 4082, 5718, 4418, 3038, 4849,
    2097, 3824, 5800, 1787, 4682, 3507,
  ];
  const values = new Float32Array(size * size).fill(2000);
  for (let y = 10; y < 70; y++) for (let x = 10; x < 70; x++) {
    values[y * size + x] = Math.max(2000, 3500 - Math.hypot(x - 40, y - 40) * 50);
  }
  const segments: Segment[] = [[[tile.x / scale, tile.y / scale], [(tile.x + 1) / scale, (tile.y + 1) / scale]]];
  const isolated = terrainIsolines(values, size, tile, segments, 500, 512).lines;
  for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) values[(125 + y) * size + 125 + x] = patch[y * 6 + x]!;
  const { lines } = terrainIsolines(values, size, tile, segments, 500, 512);
  const peakPaths = (lines: typeof isolated) => lines.flatMap(line => line.coordinates.filter(path => path.every(point => {
    const [x, y] = project(point);
    return x * scale - tile.x < 0.3 && y * scale - tile.y < 0.3;
  })));
  assert.ok(peakPaths(isolated).length >= 2);
  assert.deepEqual(peakPaths(lines), peakPaths(isolated), 'an unrelated saddle must not disable the peak smoothing');
  const edges: { a: Point; b: Point; elevation: number }[] = [];
  const elevations = new Set<number>();
  for (const line of lines) {
    elevations.add(line.elevation);
    for (const coordinates of line.coordinates) {
      const points = coordinates.map(point => {
        const [x, y] = project(point);
        return [x * scale - tile.x, y * scale - tile.y] as Point;
      });
      for (let i = 1; i < points.length; i++) edges.push({ a: points[i - 1]!, b: points[i]!, elevation: line.elevation });
    }
  }
  assert.ok([3000, 3500, 4000].every(elevation => elevations.has(elevation)), 'retain the crowded contours');
  const side = (a: Point, b: Point, c: Point) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
    const a = edges[i]!, b = edges[j]!;
    if (a.elevation === b.elevation) continue;
    const intersects = side(a.a, a.b, b.a) * side(a.a, a.b, b.b) < -1e-28 &&
      side(b.a, b.b, a.a) * side(b.a, b.b, a.b) < -1e-28;
    assert.ok(!intersects, `${a.elevation} ft and ${b.elevation} ft contours must not cross`);
  }
});
