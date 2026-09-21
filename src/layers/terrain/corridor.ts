import clipping, { type Polygon } from 'polygon-clipping';
import { INNER_NM, nmPerWorldUnit, unproject, type Point, type Segment } from './geometry';

/** Outline the same latitude-adjusted Mercator distance used by the terrain mask.
 * Union the leg buffers so bends, crossings and shared legs have no internal seams.
 * This geometry only changes with the route, never with the camera or altitude. */
export function terrainCorridor(segments: readonly Segment[]): GeoJSON.FeatureCollection<GeoJSON.MultiLineString> {
  const polygons: Polygon[] = [];
  const seen = new Set<string>();
  for (const [a, b] of segments) {
    const shift = Math.floor((a[0] + b[0]) / 2);
    const segment: Segment = [[a[0] - shift, a[1]], [b[0] - shift, b[1]]];
    const key = segment.map(point => point.join(',')).sort().join(';');
    if (seen.has(key)) continue;
    seen.add(key);
    const ring = legBuffer(segment);
    polygons.push([ring]);
    // Include the adjacent world only when the buffer crosses the date line.
    if (ring.some(([x]) => x < 0)) polygons.push([ring.map(([x, y]) => [x + 1, y])]);
    if (ring.some(([x]) => x > 1)) polygons.push([ring.map(([x, y]) => [x - 1, y])]);
  }
  if (!polygons.length) return { type: 'FeatureCollection', features: [] };
  const merged = clipping.union(polygons[0]!, ...polygons.slice(1));
  const coordinates = merged.flatMap(polygon => polygon.flatMap(clipWorld)).map(path => path.map(unproject));
  return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {},
    geometry: { type: 'MultiLineString', coordinates } }] };
}

function offset(point: Point, angle: number): Point {
  const dx = Math.cos(angle), dy = Math.sin(angle);
  let radius = INNER_NM / nmPerWorldUnit(point[1]);
  // The mask measures ground scale at the boundary, not at the route centerline.
  for (let i = 0; i < 6; i++) radius = INNER_NM / nmPerWorldUnit(point[1] + dy * radius);
  return [point[0] + dx * radius, point[1] + dy * radius];
}

function legBuffer([a, b]: Segment): Point[] {
  const dx = b[0] - a[0], dy = b[1] - a[1], angle = Math.atan2(dy, dx);
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) * 512));
  const ring: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    ring.push(offset([a[0] + dx * i / steps, a[1] + dy * i / steps], angle - Math.PI / 2));
  }
  for (let i = 1; i <= 64; i++) ring.push(offset(b, angle - Math.PI / 2 + Math.PI * i / 64));
  for (let i = steps - 1; i >= 0; i--) {
    ring.push(offset([a[0] + dx * i / steps, a[1] + dy * i / steps], angle + Math.PI / 2));
  }
  for (let i = 1; i < 64; i++) ring.push(offset(a, angle + Math.PI / 2 + Math.PI * i / 64));
  ring.push(ring[0]!);
  return ring;
}

/** Clip lines, not polygons: closing a clipped polygon would draw a false
 * north/south boundary along the antimeridian. MapLibre repeats this world. */
function clipWorld(ring: Point[]): Point[][] {
  const paths: Point[][] = [];
  let path: Point[] = [];
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1]!, b = ring[i]!, dx = b[0] - a[0];
    let start = 0, end = 1;
    if (dx) {
      const t0 = -a[0] / dx, t1 = (1 - a[0]) / dx;
      start = Math.max(0, Math.min(t0, t1)); end = Math.min(1, Math.max(t0, t1));
    } else if (a[0] < 0 || a[0] > 1) continue;
    if (start > end) continue;
    const at = (t: number): Point => t === 0 ? a : t === 1 ? b
      : [Math.max(0, Math.min(1, a[0] + dx * t)), a[1] + (b[1] - a[1]) * t];
    const from = at(start), to = at(end), last = path.at(-1);
    if (!last || last[0] !== from[0] || last[1] !== from[1]) { path = [from]; paths.push(path); }
    path.push(to);
  }
  return paths;
}
