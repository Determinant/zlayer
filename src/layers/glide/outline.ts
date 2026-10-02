import type { Point } from '../../core/geo/route-corridor';
import { FEET_PER_NM } from './airports';

export const GLIDE_INSET_NM = .1;
export const GLIDE_SIMPLIFY_NM = .05;
const SMOOTH_NM = .1;

/** Shared edges stay inside both adjacent sectors. A locally longer sector also
 * gets its own inset tip, so neighboring valley walls cannot erase its reach.
 * Every segment stays inside its proven sector triangle. */
export function glideSectorPaths(center: Point, radii: readonly number[], feetPerWorldUnit: number): Point[][] {
  const n = radii.length, inset = GLIDE_INSET_NM * FEET_PER_NM / feetPerWorldUnit;
  const allowance = SMOOTH_NM * FEET_PER_NM / feetPerWorldUnit;
  const limits = radii.map((radius, i) => Math.max(0, Math.min(radius, radii[(i + n - 1) % n]!) - inset));
  let smooth = limits;
  for (let pass = 0; pass < 2; pass++) smooth = smooth.map((radius, i) => Math.min(radius,
    Math.max(limits[i]! - allowance, (smooth[(i + n - 1) % n]! + 2 * radius + smooth[(i + 1) % n]!) / 4)));
  const points: Point[] = smooth.map((radius, i) => [center[0] + Math.cos(i / n * Math.PI * 2) * radius,
    center[1] + Math.sin(i / n * Math.PI * 2) * radius]);
  return radii.map((radius, i) => {
    const a = points[i]!, b = points[(i + 1) % n]!;
    const neighbors = Math.max(radii[(i + n - 1) % n]!, radii[(i + 1) % n]!);
    if (radius <= neighbors + 2 * allowance) return [a, b];
    // The cosine places the tip inside the original sector's chord, including
    // when adjacent sectors are blocked. Smoothing may trim at most 0.1 NM more.
    const tip = Math.max(0, radius * Math.cos(Math.PI / n) - inset - allowance);
    const angle = (i + .5) / n * Math.PI * 2;
    return [a, [center[0] + Math.cos(angle) * tip, center[1] + Math.sin(angle) * tip], b];
  });
}

export function glideBoundary(center: Point, radii: readonly number[], feetPerWorldUnit: number): Point[] {
  const points = glideSectorPaths(center, radii, feetPerWorldUnit).flatMap(path => path.slice(0, -1));
  points.push(points[0]!);
  return points;
}

/** Douglas–Peucker with an additional inward half-plane constraint. Paths must
 * follow increasing radial bearings and be split into spans of at most 90°.
 * A shortcut is accepted only if ALL skipped vertices are on its outward side.
 * Hence the shortcut stays inside the star-shaped input, including deep notches.
 * This is intentionally not a general polygon/topology simplifier. */
export function simplifyGlidePath(points: readonly Point[], feetPerWorldUnit: number, quarter: number): Point[] {
  if (points.length < 3) return [...points];
  const tolerance = GLIDE_SIMPLIFY_NM * FEET_PER_NM / feetPerWorldUnit;
  const keep = new Set<number>([0, points.length - 1]);
  function simplify(start: number, end: number) {
    if (end - start <= 1) return;
    const a = points[start]!, b = points[end]!, dx = b[0] - a[0], dy = b[1] - a[1], length2 = dx * dx + dy * dy;
    let farthest = -1, maximum = tolerance * tolerance, outside = -1, crossMaximum = 0;
    for (let i = start + 1; i < end; i++) {
      const p = points[i]!, px = p[0] - a[0], py = p[1] - a[1];
      const cross = dx * py - dy * px;
      if (cross > crossMaximum) { outside = i; crossMaximum = cross; }
      const t = length2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / length2)) : 0;
      const distance2 = (px - t * dx) ** 2 + (py - t * dy) ** 2;
      if (distance2 > maximum) { farthest = i; maximum = distance2; }
    }
    const split = outside >= 0 ? outside : farthest;
    if (split >= 0) { keep.add(split); simplify(start, split); simplify(split, end); }
  }
  for (let start = 0; start < points.length - 1; start += quarter) {
    const end = Math.min(points.length - 1, start + quarter);
    keep.add(start); keep.add(end); simplify(start, end);
  }
  return [...keep].sort((a, b) => a - b).map(index => points[index]!);
}
