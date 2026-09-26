import { compactRadarRing } from './radar-contours';

type Point = [number, number];
type Ring = Point[];
type Edge = { ring: Ring; start: number; end: number; a: Point; b: Point };
type Box = [number, number, number, number];

// A tenth of an MRMS cell (0.001°, at most about 112 m). Work in the native
// Cartesian grid; this tolerance is not appropriate for TDWR polar coordinates.
export const MRMS_SIMPLIFY_CELLS = .1;
const BIN_CELLS = 4;
const MAX_CHORD_CELLS = 16;

const boxOf = (points: Ring): Box => {
  const box: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of points) {
    box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y);
    box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y);
  }
  return box;
};
const same = (a: Point, b: Point) => a[0] === b[0] && a[1] === b[1];
const cross = (a: Point, b: Point, p: Point) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
const onSegment = (a: Point, b: Point, p: Point) => cross(a, b, p) === 0 &&
  p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]) && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
function intersects(a: Point, b: Point, c: Point, d: Point): boolean {
  const ac = cross(a, b, c), ad = cross(a, b, d), ca = cross(c, d, a), cb = cross(c, d, b);
  return ac * ad < 0 && ca * cb < 0 || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}
function inside(point: Point, ring: Ring): boolean {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if (onSegment(a, b, point)) return true;
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] <
      (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}
function distanceSquared(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const along = dx || dy ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy))) : 0;
  return (p[0] - a[0] - along * dx) ** 2 + (p[1] - a[1] - along * dy) ** 2;
}

/** RDP with conservative topology checks across every threshold, island and hole.
 * A replacement may neither cross another edge nor sweep over another vertex.
 * Keep original edges in the index as well as accepted chords: later changes
 * cannot undo an earlier check. Rings are never dropped or merged. */
export function simplifyMrms(levels: Point[][][][]): Point[][][][] {
  const result = levels.map(polygons => polygons.map(polygon => polygon.map(compactRadarRing)));
  const bins = new Map<string, Edge[]>();
  function visit(box: Box, action: (key: string) => void) {
    for (let x = Math.floor(box[0] / BIN_CELLS); x <= Math.floor(box[2] / BIN_CELLS); x++) {
      for (let y = Math.floor(box[1] / BIN_CELLS); y <= Math.floor(box[3] / BIN_CELLS); y++) action(`${x}/${y}`);
    }
  }
  function add(edge: Edge) {
    visit(boxOf([edge.a, edge.b]), key => {
      const bucket = bins.get(key);
      if (bucket) bucket.push(edge); else bins.set(key, [edge]);
    });
  }
  for (const polygons of result) for (const polygon of polygons) for (const ring of polygon) {
    for (let start = 0; start < ring.length - 1; start++) add({ ring, start, end: start + 1, a: ring[start]!, b: ring[start + 1]! });
  }
  function safe(ring: Ring, start: number, end: number): boolean {
    const a = ring[start]!, b = ring[end]!, swept = ring.slice(start, end + 1);
    const candidates = new Set<Edge>();
    visit(boxOf(swept), key => { for (const edge of bins.get(key) ?? []) candidates.add(edge); });
    for (const edge of candidates) {
      if (edge.ring === ring && edge.start >= start && edge.end <= end) continue;
      const shared = edge.ring === ring && (same(a, edge.a) || same(a, edge.b) || same(b, edge.a) || same(b, edge.b));
      if (intersects(a, b, edge.a, edge.b)) {
        if (!shared) return false;
        // Adjacent edges may meet at the retained endpoint, but not overlap.
        const joint = same(a, edge.a) || same(a, edge.b) ? a : b;
        const alongChord = same(joint, a) ? b : a;
        const alongEdge = same(joint, edge.a) ? edge.b : edge.a;
        if (cross(joint, alongChord, alongEdge) === 0 &&
          (alongChord[0] - joint[0]) * (alongEdge[0] - joint[0]) + (alongChord[1] - joint[1]) * (alongEdge[1] - joint[1]) > 0) return false;
      }
      // An entire small island or hole can lie inside the swept strip without
      // crossing the chord. Checking its vertices preserves that relationship.
      for (const point of [edge.a, edge.b]) {
        if (shared && (same(point, a) || same(point, b))) continue;
        if (inside(point, swept)) return false;
      }
    }
    return true;
  }
  function simplify(ring: Ring): Ring {
    if (ring.length <= 5) return ring;
    const kept = new Uint8Array(ring.length);
    kept[0] = kept[ring.length - 1] = 1;
    const pending = [[0, ring.length - 1]];
    while (pending.length) {
      const [start, end] = pending.pop()! as [number, number];
      if (end - start <= 1) continue;
      let farthest = start + 1, maximum = -1;
      for (let i = start + 1; i < end; i++) {
        const distance = distanceSquared(ring[i]!, ring[start]!, ring[end]!);
        if (distance > maximum) { maximum = distance; farthest = i; }
      }
      if (maximum <= MRMS_SIMPLIFY_CELLS ** 2) {
        const chordLength = distanceSquared(ring[start]!, ring[end]!, ring[end]!);
        if (chordLength <= MAX_CHORD_CELLS ** 2 && safe(ring, start, end)) {
          add({ ring, start, end, a: ring[start]!, b: ring[end]! });
          continue;
        }
        // Split long or obstructed spans instead of abandoning useful shorter
        // replacements. Small rings retain at least their original corners.
        farthest = Math.floor((start + end) / 2);
      }
      kept[farthest] = 1;
      pending.push([start, farthest], [farthest, end]);
    }
    const simplified = ring.filter((_, index) => kept[index]);
    return simplified.length >= 4 ? simplified : ring;
  }
  return result.map(polygons => polygons.map(polygon => polygon.map(simplify)));
}
