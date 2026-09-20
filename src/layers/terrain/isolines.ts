import { corridorDistance, corridorOpacity, distanceToSegment, unproject, type Point, type Segment, type Tile } from './geometry';
import type { TerrainLabel } from './contours';

export type TerrainIsoline = { coordinates: Point[][]; elevation: number; opacity: number };
type Vertex = { point: Point; neighbors: Vertex[]; visited?: boolean };

/** March the simplified height grid, then join shared cell edges into paths.
 * Extend sample centers to the tile boundary so outlines reach the same edge as fills. */
export function traceContours(values: Float32Array, size: number, interval: number): { elevation: number; points: Point[] }[] {
  const graphs = new Map<number, Map<string, Vertex>>();
  const position = (i: number) => Math.max(0, Math.min(1, (i - 0.5) / size));
  const value = (x: number, y: number) => values[Math.max(0, Math.min(size - 1, y - 1)) * size + Math.max(0, Math.min(size - 1, x - 1))]!;
  for (let y = 0; y <= size; y++) for (let x = 0; x <= size; x++) {
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
  const paths: { elevation: number; points: Point[] }[] = [];
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

/** Bound vector detail to a fraction of one display pixel, keeping loop closure. */
function simplify(points: Point[], tolerance: number): Point[] {
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const pending = [[0, points.length - 1]];
  while (pending.length) {
    const [first, last] = pending.pop()!;
    let farthest = tolerance, split = -1;
    for (let i = first! + 1; i < last!; i++) {
      const distance = distanceToSegment(points[i]!, [points[first!]!, points[last!]!]);
      if (distance > farthest) { farthest = distance; split = i; }
    }
    if (split !== -1) { keep[split] = 1; pending.push([first!, split], [split, last!]); }
  }
  return points.filter((_, index) => keep[index]);
}

/** Fade short outline spans in 1/32 opacity steps; group them into multilines so
 * the core stays a single path and fading does not create a feature per cell. */
export function terrainIsolines(values: Float32Array, size: number, tile: Tile, segments: readonly Segment[],
  interval: number, displaySize: number): { lines: TerrainIsoline[]; labels: TerrainLabel[] } {
  const groups = new Map<string, TerrainIsoline>(), labels: TerrainLabel[] = [];
  const labeled = new Set<number>(), scale = 2 ** tile.z;
  for (const { elevation, points } of traceContours(values, size, interval)) {
    const path = simplify(points, 0.2 / displaySize).map(([x, y]): Point => [(tile.x + x) / scale, (tile.y + y) / scale]);
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
