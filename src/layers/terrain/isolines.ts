import { corridorDistance, corridorOpacity, unproject, type Point, type Segment, type Tile } from './geometry';
import type { TerrainLabel } from './contours';

export type TerrainIsoline = { coordinates: Point[][]; elevation: number; opacity: number };
type ContourPath = { elevation: number; points: Point[] };
type Vertex = { point: Point; neighbors: Vertex[]; visited?: boolean };

/** March the height grid and join shared cell edges. Route tiles stop at sample
 * centers; their cached border samples supply the cells between adjacent tiles. */
export function traceContours(values: Float32Array, size: number, interval: number, extend = true): ContourPath[] {
  const graphs = new Map<number, Map<string, Vertex>>();
  const padding = extend ? 1 : 0, cells = size - 1 + 2 * padding;
  const position = (i: number) => Math.max(0, Math.min(1, (i + 0.5 - padding) / size));
  const value = (x: number, y: number) => values[Math.max(0, Math.min(size - 1, y - padding)) * size + Math.max(0, Math.min(size - 1, x - padding))]!;
  for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) {
    const a = value(x, y), b = value(x + 1, y), c = value(x + 1, y + 1), d = value(x, y + 1);
    const low = Math.min(a, b, c, d), high = Math.max(a, b, c, d);
    const first = Math.max(interval, Math.ceil(low / interval) * interval);
    // Most cells contain no boundary: avoid allocating graph work for their fills.
    if (!Number.isFinite(low + high) || low === high || first > high) continue;
    const heights = [a, b, c, d];
    for (let elevation = first; elevation <= high; elevation += interval) {
      const crossings: number[] = [];
      for (let edge = 0; edge < 4; edge++) if ((heights[edge]! >= elevation) !== (heights[(edge + 1) % 4]! >= elevation)) crossings.push(edge);
      if (!crossings.length) continue;
      let graph = graphs.get(elevation);
      if (!graph) { graph = new Map(); graphs.set(elevation, graph); }
      const corners: Point[] = [[position(x), position(y)], [position(x + 1), position(y)],
        [position(x + 1), position(y + 1)], [position(x), position(y + 1)]];
      const keys = [`h${x}/${y}`, `v${x + 1}/${y}`, `h${x}/${y + 1}`, `v${x}/${y}`];
      const vertex = (edge: number): Vertex => {
        const key = keys[edge]!;
        let result = graph!.get(key);
        if (!result) {
          const next = (edge + 1) % 4, a = corners[edge]!, b = corners[next]!;
          const t = (elevation - heights[edge]!) / (heights[next]! - heights[edge]!);
          result = { point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], neighbors: [] };
          graph!.set(key, result);
        }
        return result;
      };
      const connect = (a: number, b: number) => {
        const from = vertex(a), to = vertex(b);
        from.neighbors.push(to); to.neighbors.push(from);
      };
      if (crossings.length === 2) connect(crossings[0]!, crossings[1]!);
      // Resolve saddles using the bilinear surface used by the fill. The corner
      // average can connect the wrong diagonal when the four heights are uneven.
      else if ((a - elevation) * (c - elevation) >= (b - elevation) * (d - elevation)) {
        connect(0, 1); connect(2, 3);
      } else { connect(0, 3); connect(1, 2); }
    }
  }
  const paths: ContourPath[] = [];
  for (const [elevation, graph] of graphs) {
    const walk = (start: Vertex) => {
      if (start.visited) return;
      const points: Point[] = [];
      let current: Vertex | undefined = start, previous: Vertex | undefined;
      while (current && !current.visited) {
        current.visited = true; points.push(current.point);
        const next: Vertex | undefined = current.neighbors.find(vertex => vertex !== previous);
        previous = current; current = next;
      }
      if (current === start) points.push(start.point);
      if (points.length > 1) paths.push({ elevation, points });
    };
    for (const vertex of graph.values()) if (vertex.neighbors.length === 1) walk(vertex);
    for (const vertex of graph.values()) walk(vertex);
  }
  return paths;
}

/** Two bounded corner-cutting passes soften DEM stair steps without overshoot.
 * Only traced paths grow (at most 4x), not the elevation grid. Keep open ends
 * fixed so tile boundaries and missing-data gaps cannot move or close. */
export function smoothContour(points: Point[], maxCut: number): Point[] {
  if (points.length < 3) return points;
  const first = points[0]!, last = points[points.length - 1]!;
  const closed = first[0] === last[0] && first[1] === last[1];
  const limitSquared = (4 * maxCut) ** 2;
  for (let pass = 0; pass < 2; pass++) {
    const rounded: Point[] = closed ? [] : [points[0]!];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!, b = points[i]!;
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const lengthSquared = dx * dx + dy * dy;
      const fraction = lengthSquared > limitSquared ? maxCut / Math.sqrt(lengthSquared) : 0.25;
      rounded.push([a[0] + dx * fraction, a[1] + dy * fraction],
        [b[0] - dx * fraction, b[1] - dy * fraction]);
    }
    rounded.push(closed ? rounded[0]! : points[points.length - 1]!);
    points = rounded;
  }
  return points;
}

/** Bound vector detail to a fraction of one display pixel, keeping loop closure. */
function simplify(points: Point[], tolerance: number): Point[] {
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const pending = [[0, points.length - 1]];
  while (pending.length) {
    const [first, last] = pending.pop()!;
    const a = points[first!]!, b = points[last!]!, dx = b[0] - a[0], dy = b[1] - a[1];
    const inverseLength = 1 / (dx * dx + dy * dy || 1);
    let farthest = tolerance * tolerance, split = -1;
    for (let i = first! + 1; i < last!; i++) {
      // Reuse the span's projection and compare squared distances: the extra
      // rounding vertices need neither a temporary segment nor a square root.
      const px = points[i]![0] - a[0], py = points[i]![1] - a[1];
      const t = Math.max(0, Math.min(1, (px * dx + py * dy) * inverseLength));
      const distance = (px - t * dx) ** 2 + (py - t * dy) ** 2;
      if (distance > farthest) { farthest = distance; split = i; }
    }
    if (split !== -1) { keep[split] = 1; pending.push([first!, split], [split, last!]); }
  }
  const result = points.filter((_, index) => keep[index]);
  const first = points[0]!, last = points[points.length - 1]!;
  // A contour around a tiny summit must remain a ring even when its diameter
  // falls below the display tolerance.
  return result.length < 4 && first[0] === last[0] && first[1] === last[1] ? points : result;
}

/** Check rounded paths against both their original neighbors and each other.
 * Reject only conflicting paths: every accepted curve is safe even when a
 * neighbor reverts, and an isolated saddle cannot make a whole tile jagged. */
function conflictingContours(original: ContourPath[], rounded: ContourPath[], displaySize: number): Set<number> {
  const rejected = new Set<number>();
  if (original.length < 2) return rejected;
  type Edge = { a: Point; b: Point; elevation: number; path: number; rounded: boolean; left: number; top: number;
    minX: number; maxX: number; minY: number; maxY: number };
  const cells = Math.ceil(displaySize / 16), buckets = new Array<Edge[] | undefined>(cells * cells);
  const cell = (value: number) => Math.max(0, Math.min(cells - 1, Math.floor(value * cells)));
  const side = (a: Point, b: Point, c: Point) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (const paths of [original, rounded]) for (const [path, { elevation, points }] of paths.entries()) for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    const minX = Math.min(a[0], b[0]), maxX = Math.max(a[0], b[0]);
    const minY = Math.min(a[1], b[1]), maxY = Math.max(a[1], b[1]);
    const left = cell(minX), right = cell(maxX), top = cell(minY), bottom = cell(maxY);
    const edge: Edge = { a, b, elevation, path, rounded: paths === rounded, left, top, minX, maxX, minY, maxY };
    for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
      const bucket = buckets[y * cells + x] ??= [];
      for (const other of bucket) {
        if (other.elevation === elevation || (!edge.rounded && !other.rounded)) continue;
        // Long spans can share several buckets. Compare each pair only once.
        if (x !== Math.max(left, other.left) || y !== Math.max(top, other.top)) continue;
        if (minX > other.maxX || maxX < other.minX || minY > other.maxY || maxY < other.minY) continue;
        if (side(a, b, other.a) * side(a, b, other.b) <= 0 &&
          side(other.a, other.b, a) * side(other.a, other.b, b) <= 0) {
          if (edge.rounded) rejected.add(path);
          if (other.rounded) rejected.add(other.path);
        }
      }
      bucket.push(edge);
    }
  }
  return rejected;
}

/** Fade short outline spans in 1/32 opacity steps; group them into multilines so
 * the core stays a single path and fading does not create a feature per cell. */
export function terrainIsolines(values: Float32Array, size: number, tile: Tile, segments: readonly Segment[],
  interval: number, displaySize: number, extend = true): { lines: TerrainIsoline[]; labels: TerrainLabel[] } {
  const groups = new Map<string, TerrainIsoline>(), labels: TerrainLabel[] = [];
  const labeled = new Set<number>(), scale = 2 ** tile.z;
  const traced = traceContours(values, size, interval, extend);
  const paths = traced.map(({ elevation, points }) => {
    // Round at the source-cell scale so close views soften the actual stair
    // steps, not just their tips. Endpoints remain fixed for stitching.
    const rounded = smoothContour(simplify(points, 1 / displaySize), 1.5 / size);
    return { elevation, points: simplify(rounded, 0.2 / displaySize) };
  });
  const rejected = conflictingContours(traced, paths, displaySize);
  for (const index of rejected) paths[index] = traced[index]!;
  for (const { elevation, points } of paths) {
    const path = points.map(([x, y]): Point => [(tile.x + x) / scale, (tile.y + y) / scale]);
    let previousOpacity = -1, run: Point[] | undefined;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!, b = path[i]!;
      // Keep fade transitions small even along long, straight simplified paths.
      const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * scale * displaySize / 4));
      for (let step = 0; step < steps; step++) {
        const point = (t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        const middle = point((step + 0.5) / steps);
        const opacity = Math.round(corridorOpacity(corridorDistance(middle, segments)) * 32) / 32;
        if (opacity === 0) { previousOpacity = -1; run = undefined; continue; }
        const continuing = opacity === previousOpacity && run;
        if (!continuing) {
          const key = `${elevation}/${opacity}`;
          let group = groups.get(key);
          if (!group) { group = { elevation, opacity, coordinates: [] }; groups.set(key, group); }
          run = [unproject(point(step / steps))]; group.coordinates.push(run);
        }
        const end = unproject(point((step + 1) / steps));
        if (continuing && step > 0) run![run!.length - 1] = end;
        else run!.push(end);
        previousOpacity = opacity;
        if (elevation % 1000 === 0 && opacity > 0.5 && !labeled.has(elevation) && path.length > 4) {
          labeled.add(elevation);
          labels.push({ elevation, opacity, peak: false, coordinate: unproject(middle) });
        }
      }
    }
  }
  return { lines: [...groups.values()], labels };
}
