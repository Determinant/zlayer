import clipping, { type MultiPolygon, type Polygon } from 'polygon-clipping';
import type { Bounds } from '@zlayer/contracts';
import { project, nmPerWorldUnit, type Point, type Segment } from '../../core/geo/route-corridor';
import type { GlideAreas } from './types';

export function polygonBounds(polygons: MultiPolygon): Bounds {
  const bounds: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const polygon of polygons) for (const ring of polygon) for (const [x, y] of ring) {
    bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y);
    bounds[2] = Math.max(bounds[2], x); bounds[3] = Math.max(bounds[3], y);
  }
  return bounds;
}

/** Rank projected bounds from the actual calculation origins, independent of
 * camera position. Bounds are a conservative proxy until a block is decoded. */
export function landingPriority(ranges: GlideAreas | undefined, fallback: Point): (bounds: Bounds) => number {
  const origins = ranges?.features.flatMap(feature => {
    const origin: unknown = feature.properties?.glideOrigin;
    return Array.isArray(origin) && origin.length === 2 && origin.every(Number.isFinite)
      ? [project(origin as Point)] : [];
  }) ?? [];
  if (!origins.length) origins.push(fallback);
  const centers = origins.map(point => ({ point, scale: nmPerWorldUnit(point[1]) }));
  return ([west, north, east, south]) => Math.min(...centers.map(({ point: [x, y], scale }) => {
    const localX = x + Math.round((west + east) / 2 - x);
    const dx = Math.max(west - localX, 0, localX - east), dy = Math.max(north - y, 0, y - south);
    return Math.hypot(dx, dy) * scale;
  }));
}

const overlaps = (a: Bounds, b: Bounds) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/** Reuse mask bounds across candidate clips. A candidate box with no boundary
 * crossings is wholly inside or outside; boundary cases still use exact clipping. */
export function prepareLandingMask(mask: MultiPolygon) {
  const parts = mask.map(polygon => ({ polygon, bounds: polygonBounds([polygon]),
    edges: polygon.flatMap(ring => ring.map(([x, y], i): Bounds => {
      const previous = ring[(i + ring.length - 1) % ring.length]!;
      return [Math.min(x, previous[0]), Math.min(y, previous[1]), Math.max(x, previous[0]), Math.max(y, previous[1])];
    })) }));
  return {
    clip(polygon: Polygon, bounds = polygonBounds([polygon])): MultiPolygon {
      const boundary: Polygon[] = [];
      for (const part of parts) {
        if (!overlaps(bounds, part.bounds)) continue;
        // Include every ring: a hole entirely within the candidate box must also
        // take the exact path. Edge boxes can over-admit, but never skip a crossing.
        if (part.edges.some(edge => overlaps(bounds, edge))) boundary.push(part.polygon);
        else if (containsPoint([bounds[0], bounds[1]], part.polygon)) return [polygon];
      }
      return boundary.length ? clipping.intersection(polygon, boundary) : [];
    },
  };
}

/** Even-odd containment includes the outer edge but excludes hole interiors. */
export function containsPoint([x, y]: Point, polygon: Polygon): boolean {
  let inside = false;
  for (const ring of polygon) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]!, b = ring[i]!;
    if (a[0] === b[0] && a[1] === b[1]) continue;
    const cross = (x - a[0]) * (b[1] - a[1]) - (y - a[1]) * (b[0] - a[0]);
    if (Math.abs(cross) < 1e-20 && x >= Math.min(a[0], b[0]) && x <= Math.max(a[0], b[0])
      && y >= Math.min(a[1], b[1]) && y <= Math.max(a[1], b[1])) return true;
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Measure route portions inside a computed arrival footprint, including holes.
 * This does not extrapolate uncalculated candidates or count nearby patches. */
export function coveredRouteNm(segments: Segment[], coverage: GlideAreas): number {
  const polygons = coverage.features.flatMap(f => f.geometry.coordinates).map(p => p.map(r => r.map(c => project(c as Point))));
  let distance = 0;
  for (const [a, b] of segments) {
    const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
    if (!length) continue;
    const local = polygons.map(p => {
      const shift = Math.round((a[0] + b[0]) / 2 - p[0]![0]![0]);
      return p.map(r => r.map(([x, y]) => [x + shift, y] as Point));
    });
    const cuts = [0, 1];
    for (const polygon of local) for (const ring of polygon) for (let i = 1; i < ring.length; i++) {
      const c = ring[i - 1]!, d = ring[i]!, ex = d[0] - c[0], ey = d[1] - c[1];
      const denominator = dx * ey - dy * ex;
      if (!denominator) continue;
      const t = ((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / denominator;
      const u = ((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / denominator;
      if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(t);
    }
    cuts.sort((a, b) => a - b);
    for (let i = 1; i < cuts.length; i++) {
      const lo = cuts[i - 1]!, hi = cuts[i]!, mid = (lo + hi) / 2;
      const point: Point = [a[0] + mid * dx, a[1] + mid * dy];
      if (local.some(p => containsPoint(point, p))) distance += (hi - lo) * length * nmPerWorldUnit(point[1]);
    }
  }
  return distance;
}

/** Even-odd spans at a pixel-center row, retaining holes in disjoint polygons. */
export function landingRowSpans(mask: MultiPolygon, y: number): [number, number][] {
  const spans: [number, number][] = [];
  for (const polygon of mask) {
    const cuts: number[] = [];
    for (const ring of polygon) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j]!, b = ring[i]!;
      if ((a[1] > y) !== (b[1] > y)) cuts.push(a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]));
    }
    cuts.sort((a, b) => a - b);
    for (let i = 0; i + 1 < cuts.length; i += 2) spans.push([cuts[i]!, cuts[i + 1]!]);
  }
  return spans;
}
