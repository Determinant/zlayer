/*
Adapted from d3-contour 4.0.2: marching squares and linear crossing interpolation.
Copyright 2012-2023 Mike Bostock

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
*/

type Position = [number, number];
type Fragment = { start: number; end: number; ring: Position[] };
const HOLE_ROW_CELLS = 32;
const cases: Position[][][] = [
  [],
  [[[1.0, 1.5], [0.5, 1.0]]],
  [[[1.5, 1.0], [1.0, 1.5]]],
  [[[1.5, 1.0], [0.5, 1.0]]],
  [[[1.0, 0.5], [1.5, 1.0]]],
  [[[1.0, 1.5], [0.5, 1.0]], [[1.0, 0.5], [1.5, 1.0]]],
  [[[1.0, 0.5], [1.0, 1.5]]],
  [[[1.0, 0.5], [0.5, 1.0]]],
  [[[0.5, 1.0], [1.0, 0.5]]],
  [[[1.0, 1.5], [1.0, 0.5]]],
  [[[0.5, 1.0], [1.0, 0.5]], [[1.5, 1.0], [1.0, 1.5]]],
  [[[1.5, 1.0], [1.0, 0.5]]],
  [[[0.5, 1.0], [1.5, 1.0]]],
  [[[1.0, 1.5], [1.5, 1.0]]],
  [[[0.5, 1.0], [1.0, 1.5]]],
  []
];

/** Qualified finite radar samples. Preserve D3 crossings, drop zero-area rings,
 * and index exterior bounds before assigning holes. */
export function radarContours(values: Float32Array, dx: number, dy: number, threshold: number): Position[][][] {
  // Accumulate, smooth contour rings, assign holes to exterior rings.
  // Based on https://github.com/mbostock/shapefile/blob/v0.6.2/shp/polygon.js
  function contour(): Position[][][] {
    const v = threshold;
    if (!Number.isFinite(v)) throw new Error('Invalid radar contour threshold');

    const polygons: Position[][][] = [], holes: Position[][] = [];

    isorings(values, v, function(ring) {
      smoothLinear(ring, values, v);
      const signedArea = area(ring);
      if (signedArea > 0) polygons.push([ring]);
      else if (signedArea < 0) holes.push(ring);
    });

    // Ring containment dominates sparse national scans. A containing polygon
    // must cross the hole's first row; preserve original candidate order.
    const boxes = polygons.map(polygon => bounds(polygon[0]!));
    const rows = new Map<number, number[]>();
    boxes.forEach((box, index) => {
      for (let row = Math.floor(box[1] / HOLE_ROW_CELLS); row <= Math.floor(box[3] / HOLE_ROW_CELLS); row++) {
        const bucket = rows.get(row) ?? [];
        bucket.push(index); rows.set(row, bucket);
      }
    });
    for (const hole of holes) {
      const box = bounds(hole);
      for (const index of rows.get(Math.floor(hole[0]![1] / HOLE_ROW_CELLS)) ?? []) {
        const exterior = boxes[index]!;
        if (exterior[0] > box[2] || exterior[2] < box[0] || exterior[1] > box[3] || exterior[3] < box[1]) continue;
        if (contains(polygons[index]![0]!, hole) !== -1) { polygons[index]!.push(hole); break; }
      }
    }
    return polygons;
  }

  // Marching squares with isolines stitched into rings.
  // Based on https://github.com/topojson/topojson-client/blob/v3.0.0/src/stitch.js
  function isorings(values: Float32Array, value: number, callback: (ring: Position[]) => void) {
    const fragmentByStart = new Map<number, Fragment>(), fragmentByEnd = new Map<number, Fragment>();
    let x: number, y: number, t0: number, t1: number, t2: number, t3: number;

    // Special case for the first row (y = -1, t2 = t3 = 0).
    x = y = -1;
    t1 = above(values[0], value);
    cases[t1 << 1]!.forEach(stitch);
    while (++x < dx - 1) {
      t0 = t1, t1 = above(values[x + 1], value);
      cases[t0 | t1 << 1]!.forEach(stitch);
    }
    cases[t1 << 0]!.forEach(stitch);

    // General case for the intermediate rows.
    while (++y < dy - 1) {
      x = -1;
      t1 = above(values[y * dx + dx], value);
      t2 = above(values[y * dx], value);
      cases[t1 << 1 | t2 << 2]!.forEach(stitch);
      while (++x < dx - 1) {
        t0 = t1, t1 = above(values[y * dx + dx + x + 1], value);
        t3 = t2, t2 = above(values[y * dx + x + 1], value);
        cases[t0 | t1 << 1 | t2 << 2 | t3 << 3]!.forEach(stitch);
      }
      cases[t1 | t2 << 3]!.forEach(stitch);
    }

    // Special case for the last row (y = dy - 1, t0 = t1 = 0).
    x = -1;
    t2 = above(values[y * dx], value);
    cases[t2 << 2]!.forEach(stitch);
    while (++x < dx - 1) {
      t3 = t2, t2 = above(values[y * dx + x + 1], value);
      cases[t2 << 2 | t3 << 3]!.forEach(stitch);
    }
    cases[t2 << 3]!.forEach(stitch);

    function stitch(line: Position[]) {
      const start: Position = [line[0]![0] + x, line[0]![1] + y];
      const end: Position = [line[1]![0] + x, line[1]![1] + y];
      const startIndex = index(start), endIndex = index(end);
      let f: Fragment | undefined, g: Fragment | undefined;
      if (f = fragmentByEnd.get(startIndex)) {
        if (g = fragmentByStart.get(endIndex)) {
          fragmentByEnd.delete(f.end);
          fragmentByStart.delete(g.start);
          if (f === g) {
            f.ring.push(end);
            callback(f.ring);
          } else {
            const joined = { start: f.start, end: g.end, ring: f.ring.concat(g.ring) };
            fragmentByStart.set(joined.start, joined); fragmentByEnd.set(joined.end, joined);
          }
        } else {
          fragmentByEnd.delete(f.end);
          f.ring.push(end);
          f.end = endIndex; fragmentByEnd.set(endIndex, f);
        }
      } else if (f = fragmentByStart.get(endIndex)) {
        if (g = fragmentByEnd.get(startIndex)) {
          fragmentByStart.delete(f.start);
          fragmentByEnd.delete(g.end);
          if (f === g) {
            f.ring.push(end);
            callback(f.ring);
          } else {
            const joined = { start: g.start, end: f.end, ring: g.ring.concat(f.ring) };
            fragmentByStart.set(joined.start, joined); fragmentByEnd.set(joined.end, joined);
          }
        } else {
          fragmentByStart.delete(f.start);
          f.ring.unshift(start);
          f.start = startIndex; fragmentByStart.set(startIndex, f);
        }
      } else {
        const fragment = { start: startIndex, end: endIndex, ring: [start, end] };
        fragmentByStart.set(startIndex, fragment); fragmentByEnd.set(endIndex, fragment);
      }
    }
  }

  function index(point: Position) {
    return point[0] * 2 + point[1] * (dx + 1) * 4;
  }

  function smoothLinear(ring: Position[], values: Float32Array, value: number) {
    ring.forEach(function(point) {
      const [x, y] = point, xt = x | 0, yt = y | 0;
      const v1 = sample(values[yt * dx + xt]);
      if (x > 0 && x < dx && xt === x) {
        point[0] = smooth1(x, sample(values[yt * dx + xt - 1]), v1, value);
      }
      if (y > 0 && y < dy && yt === y) {
        point[1] = smooth1(y, sample(values[(yt - 1) * dx + xt]), v1, value);
      }
    });
  }


  return contour();
}

function above(value: number | undefined, threshold: number): number { return Number(value !== undefined && value >= threshold); }
function sample(value: number | undefined): number { return value ?? -Infinity; }
function smooth1(x: number, v0: number, v1: number, value: number): number {
  const a = value - v0, b = v1 - v0;
  const d = Number.isFinite(a) || Number.isFinite(b) ? a / b : Math.sign(a) / Math.sign(b);
  return Number.isNaN(d) ? x : x + d - 0.5;
}
function area(ring: Position[]): number {
  let sum = 0;
  for (let i = 1; i < ring.length; i++) sum += ring[i - 1]![1] * ring[i]![0] - ring[i - 1]![0] * ring[i]![1];
  return sum;
}

/** Remove repeated/straight crossings in native Cartesian coordinates. This
 * retains the isoline, including small rings and holes; no distance tolerance.
 * Polar TDWR geometry must retain its bearings through geographic projection. */
export function compactRadarRing(ring: Position[]): Position[] {
  const result: Position[] = [];
  for (const point of ring) {
    const previous = result.at(-1);
    if (previous && previous[0] === point[0] && previous[1] === point[1]) continue;
    while (result.length > 1) {
      const a = result.at(-2)!, b = result.at(-1)!;
      const dx = b[0] - a[0], dy = b[1] - a[1];
      if (dx * (point[1] - b[1]) !== dy * (point[0] - b[0]) ||
        dx * (point[0] - b[0]) + dy * (point[1] - b[1]) < 0) break;
      result.pop();
    }
    result.push(point);
  }
  return result.length >= 4 ? result : ring;
}
function bounds(ring: Position[]): [number, number, number, number] {
  const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of ring) {
    box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y);
    box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y);
  }
  return box;
}
function contains(ring: Position[], hole: Position[]): number {
  for (const point of hole) { const inside = ringContains(ring, point); if (inside) return inside; }
  return 0;
}
function ringContains(ring: Position[], [x, y]: Position): number {
  let inside = -1;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!, [xj, yj] = ring[j]!;
    // Check both coordinates: a repeated vertex is a point, not the entire row.
    if ((xj - xi) * (y - yi) === (x - xi) * (yj - yi) &&
      x >= Math.min(xi, xj) && x <= Math.max(xi, xj) && y >= Math.min(yi, yj) && y <= Math.max(yi, yj)) return 0;
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = -inside;
  }
  return inside;
}
