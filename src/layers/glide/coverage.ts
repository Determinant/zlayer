import clipping, { type MultiPolygon, type Polygon } from 'polygon-clipping';
import { project, unproject, distanceToSegment, nmPerWorldUnit, type Point, type Segment } from '../../core/geo/route-corridor';
import type { Bounds } from '@zlayer/contracts';
export const GLIDE_CORRIDOR_NM = 20;
export type GlideViewport = Point[];
export const viewportBounds = (viewport: GlideViewport): Bounds => {
  const xs = viewport.map(p => p[0]), ys = viewport.map(p => p[1]);
  const nw = unproject([Math.min(...xs), Math.min(...ys)]), se = unproject([Math.max(...xs), Math.max(...ys)]);
  return [nw[0], se[1], se[0], nw[1]];
};
export function boundsViewport(bounds: Bounds): GlideViewport {
  return [project([bounds[0], bounds[3]]), project([bounds[2], bounds[3]]), project([bounds[2], bounds[1]]), project([bounds[0], bounds[1]])];
}
export function unwrapPoint(coordinate: Point, viewport: GlideViewport): Point {
  const point = project(coordinate), center = viewport.reduce((sum, p) => sum + p[0], 0) / viewport.length;
  point[0] += Math.round(center - point[0]); return point;
}
export function insideViewport(point: Point, viewport: GlideViewport, inset = 0): boolean {
  let side = 0;
  for (let i = 0; i < viewport.length; i++) {
    const a = viewport[i]!, b = viewport[(i + 1) % viewport.length]!;
    const cross = (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);
    if (Math.abs(cross) < inset * Math.hypot(b[0] - a[0], b[1] - a[1]) - 1e-16) return false;
    if (Math.abs(cross) < 1e-16) continue;
    const next = Math.sign(cross);
    if (side && side !== next) return false;
    side = next;
  }
  return true;
}
export function localRouteSegments(segments: readonly Segment[], viewport: GlideViewport): Segment[] {
  const center = viewport.reduce((sum, p) => sum + p[0], 0) / viewport.length;
  const xs = viewport.map(p => p[0]), ys = viewport.map(p => p[1]);
  const padding = GLIDE_CORRIDOR_NM / Math.min(...ys.map(nmPerWorldUnit));
  const left = Math.min(...xs) - padding, right = Math.max(...xs) + padding;
  const top = Math.min(...ys) - padding, bottom = Math.max(...ys) + padding;
  const result: Segment[] = [];
  for (const [a, b] of segments) {
    const shift = Math.round(center - (a[0] + b[0]) / 2);
    const start: Point = [a[0] + shift, a[1]], end: Point = [b[0] + shift, b[1]];
    // Liang–Barsky: keep only route portions near this viewport, including
    // crossing legs whose original endpoints are both off screen.
    let lo = 0, hi = 1;
    const dx = end[0] - start[0], dy = end[1] - start[1];
    for (const [p, q] of [[-dx, start[0] - left], [dx, right - start[0]], [-dy, start[1] - top], [dy, bottom - start[1]]] as Point[]) {
      if (p === 0) { if (q < 0) hi = -1; continue; }
      if (p < 0) lo = Math.max(lo, q / p); else hi = Math.min(hi, q / p);
    }
    if (lo <= hi) result.push([[start[0] + lo * dx, start[1] + lo * dy], [start[0] + hi * dx, start[1] + hi * dy]]);
  }
  return result;
}
export const inRouteCorridor = (point: Point, segments: readonly Segment[]): boolean =>
  segments.some(segment => distanceToSegment(point, segment) * nmPerWorldUnit(point[1]) <= GLIDE_CORRIDOR_NM);

/** Inscribed capsules stay within 20 NM; only local route portions are buffered. */
export function routeMask(segments: readonly Segment[], viewport: GlideViewport): MultiPolygon {
  const view: Polygon = [[...viewport, viewport[0]!]];
  const capsules: Polygon[] = [];
  for (const [a, b] of segments) {
    const north = Math.min(a[1], b[1], ...viewport.map(p => p[1]));
    const south = Math.max(a[1], b[1], ...viewport.map(p => p[1]));
    const scale = nmPerWorldUnit(Math.max(north, Math.min(south, .5)));
    const radius = GLIDE_CORRIDOR_NM / scale * (1 - 1e-9);
    const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const ring: Point[] = [];
    for (const [center, offset] of [[b, -Math.PI / 2], [a, Math.PI / 2]] as [Point, number][]) {
      for (let i = 0; i <= 36; i++) {
        const theta = angle + offset + i / 36 * Math.PI;
        ring.push([center[0] + radius * Math.cos(theta), center[1] + radius * Math.sin(theta)]);
      }
    }
    ring.push(ring[0]!);
    capsules.push(...clipping.intersection([ring], view));
  }
  return capsules.length ? clipping.union(capsules[0]!, ...capsules.slice(1)) : [];
}

/** Ray exit from a convex viewport inset by a perpendicular distance on EVERY
 * side. Subtracting a distance along the ray leaves grazing angles too close to
 * the screen edge, where coarsened cells can include unrequested pixels. */
export function viewportRayDistance(center: Point, angle: number, viewport: GlideViewport, inset = 0): number {
  const direction: Point = [Math.cos(angle), Math.sin(angle)];
  const [a, b, c] = viewport as [Point, Point, Point, ...Point[]];
  const side = Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  if (!side) return 0;
  let radius = Infinity;
  for (let i = 0; i < viewport.length; i++) {
    const a = viewport[i]!, b = viewport[(i + 1) % viewport.length]!;
    const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
    if (!length) continue;
    const distance = side * (dx * (center[1] - a[1]) - dy * (center[0] - a[0])) / length;
    if (distance < inset) return 0;
    const velocity = side * (dx * direction[1] - dy * direction[0]) / length;
    if (velocity < 0) radius = Math.min(radius, (distance - inset) / -velocity);
  }
  return radius;
}
