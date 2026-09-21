import type { ApproachCoordinate as Coordinate } from '@zlayer/contracts';
import { bearing, destination } from './approach-geometry.js';
import { distanceNm } from './route.js';

/** One deterministic drawing policy. These dimensions are not a performance model. */
export const approachSchematicPolicy = Object.freeze({ version: 3, climbNm: 1.5, turnRadiusNm: .7, maxExtentNm: 100,
  endpointToleranceNm: .05,
  climbScales: [.5, 1.5, 2, 3, 4, 6, 8] as readonly number[] });
const rad = Math.PI / 180;
export const difference = (a: number, b: number) => (a - b + 540) % 360 - 180;
type Vector = [number, number, number];
const dot = (a: Vector, b: Vector) => a.reduce((n, x, i) => n + x * b[i]!, 0);
const cross = (a: Vector, b: Vector): Vector => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function frame([lon, lat]: Coordinate, heading: number): [Vector, Vector] {
  const x = lon * rad, y = lat * rad, h = heading * rad;
  return [[Math.cos(y) * Math.cos(x), Math.cos(y) * Math.sin(x), Math.sin(y)],
    [-Math.sin(y) * Math.cos(x) * Math.cos(h) - Math.sin(x) * Math.sin(h),
      -Math.sin(y) * Math.sin(x) * Math.cos(h) + Math.cos(x) * Math.sin(h), Math.cos(y) * Math.cos(h)]];
}

/** Forward great-circle rays, bounded to a local procedure. */
export function rayIntersection(from: Coordinate, heading: number, origin: Coordinate, radial: number): Coordinate | undefined {
  const a = frame(from, heading), b = frame(origin, radial), axis = cross(cross(...a), cross(...b));
  if (Math.hypot(...axis) < 1e-7) return undefined;
  for (const sign of [1, -1]) {
    const p: Coordinate = [Math.atan2(sign * axis[1], sign * axis[0]) / rad, Math.atan2(sign * axis[2], Math.hypot(axis[0], axis[1])) / rad];
    if (distanceNm(from, p) <= approachSchematicPolicy.maxExtentNm && distanceNm(origin, p) <= approachSchematicPolicy.maxExtentNm &&
        Math.abs(difference(bearing(from, p), heading)) < .01 && Math.abs(difference(bearing(origin, p), radial)) < .01) return p;
  }
  return undefined;
}

/** First forward intersection with a plan-view station-range circle. */
export function rangeIntersection(from: Coordinate, heading: number, center: Coordinate, radiusNm: number): Coordinate | undefined {
  if (!(radiusNm > 0 && radiusNm <= approachSchematicPolicy.maxExtentNm)) return undefined;
  const [p, v] = frame(from, heading), [c] = frame(center, 0);
  const a = dot(c, p), b = dot(c, v), magnitude = Math.hypot(a, b), ratio = Math.cos(radiusNm / 3440.065) / magnitude;
  if (Math.abs(ratio) > 1) return undefined;
  const angle = Math.atan2(b, a), offset = Math.acos(ratio);
  const distances = [angle - offset, angle + offset].map(t => ((t + 2 * Math.PI) % (2 * Math.PI)) * 3440.065)
    .filter(d => d > .001 && d <= approachSchematicPolicy.maxExtentNm).sort((a, b) => a - b);
  return distances[0] === undefined ? undefined : destination(from, heading, distances[0]);
}

function arc(center: Coordinate, from: Coordinate, to: Coordinate, side: number, radius: number): Coordinate[] {
  const start = bearing(center, from), end = bearing(center, to);
  const sweep = side > 0 ? (end - start + 360) % 360 : -((start - end + 360) % 360);
  const count = Math.max(1, Math.ceil(Math.abs(sweep) / 5));
  return Array.from({ length: count + 1 }, (_, i) => !i ? from : i === count ? to : destination(center, start + sweep * i / count, radius));
}

export function turnToHeading(from: Coordinate, initial: number, heading: number, direction?: 'L' | 'R', radius: number = approachSchematicPolicy.turnRadiusNm): Coordinate[] {
  if (Math.abs(difference(heading, initial)) < .1) return [from];
  const side = direction === 'R' ? 1 : direction === 'L' ? -1 : difference(heading, initial) < 0 ? -1 : 1;
  const center = destination(from, initial + side * 90, radius), end = destination(center, heading - side * 90, radius);
  return arc(center, from, end, side, radius);
}

/** Circle tangent followed by a straight line to a fix. No unconstrained spline. */
export function turnToFix(from: Coordinate, heading: number, to: Coordinate, direction?: 'L' | 'R'): Coordinate[] | undefined {
  const distance = distanceNm(from, to);
  if (distance < .01) return [from, to];
  if (distance > approachSchematicPolicy.maxExtentNm) return undefined;
  const side = direction === 'R' ? 1 : direction === 'L' ? -1 : difference(bearing(from, to), heading) < 0 ? -1 : 1;
  const radius = Math.min(approachSchematicPolicy.turnRadiusNm, distance / 4);
  const center = destination(from, heading + side * 90, radius), d = distanceNm(center, to);
  if (d <= radius) return undefined;
  const tangent = destination(center, bearing(center, to) - side * Math.acos(radius / d) / rad, radius);
  return [...arc(center, from, tangent, side, radius), to];
}

/** Bounded arc/straight/arc join between poses in a local tangent plane. The last
 * straight section retains the defined arrival course. All turns are schematic.
 */
export function joinCourse(from: Coordinate, heading: number, to: Coordinate, inbound: number, direction?: 'L' | 'R'): Coordinate[] | undefined {
  const distance = distanceNm(from, to);
  if (distance < .02) return [from, to];
  if (distance > approachSchematicPolicy.maxExtentNm) return undefined;
  const radius = Math.min(approachSchematicPolicy.turnRadiusNm, distance / 6);
  const end = destination(to, inbound + 180, Math.min(1, distance / 4));
  const xy = (p: Coordinate): Coordinate => { const h = bearing(from, p) * rad, d = distanceNm(from, p); return [d * Math.sin(h), d * Math.cos(h)]; };
  const geo = ([x, y]: Coordinate) => destination(from, Math.atan2(x, y) / rad, Math.hypot(x, y));
  const shift = (p: Coordinate, h: number, d: number): Coordinate => [p[0] + Math.sin(h * rad) * d, p[1] + Math.cos(h * rad) * d];
  const sample = (center: Coordinate, start: Coordinate, finish: Coordinate, side: number) => {
    const angle = (p: Coordinate) => Math.atan2(p[0] - center[0], p[1] - center[1]) / rad;
    const a = angle(start), b = angle(finish), sweep = side > 0 ? (b - a + 360) % 360 : -((a - b + 360) % 360);
    const count = Math.max(1, Math.ceil(Math.abs(sweep) / 5));
    return Array.from({ length: count + 1 }, (_, i) => !i ? start : i === count ? finish : shift(center, a + sweep * i / count, radius));
  };
  let best: Coordinate[] | undefined, length = Infinity;
  for (const first of direction === 'L' ? [-1] : direction === 'R' ? [1] : [-1, 1]) for (const last of [-1, 1]) {
    const start: Coordinate = [0, 0], target = xy(end);
    const c0 = shift(start, heading + first * 90, radius), c1 = shift(target, inbound + last * 90, radius);
    const dx = c1[0] - c0[0], dy = c1[1] - c0[1], d = Math.hypot(dx, dy);
    if (d < .001 || Math.abs((first - last) * radius / d) > 1) continue;
    const tangent = Math.atan2(dx, dy) / rad + Math.asin((first - last) * radius / d) / rad;
    const a = shift(c0, tangent - first * 90, radius), b = shift(c1, tangent - last * 90, radius);
    const coords = [...sample(c0, start, a, first), ...sample(c1, b, target, last)].map(geo);
    coords[0] = from; coords[coords.length - 1] = end; coords.push(to);
    const total = coords.slice(1).reduce((sum, p, i) => sum + distanceNm(coords[i]!, p), 0);
    if (total < length && total < distance * 3 + 6) { best = coords; length = total; }
  }
  return best;
}

/** Optional exception names one pair of zero-based segments, never a whole leg. */
export function selfCrosses(coords: Coordinate[], permitted?: readonly [number, number]): boolean {
  if (coords.length < 4) return false;
  const p = coords.map(c => [((c[0] - coords[0]![0] + 540) % 360 - 180), c[1]] as Coordinate);
  const side = (a: Coordinate, b: Coordinate, c: Coordinate) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 1; i < p.length; i++) for (let j = i + 2; j < p.length; j++) {
    if (permitted?.[0] === i - 1 && permitted[1] === j - 1) continue;
    if (side(p[i - 1]!, p[i]!, p[j - 1]!) * side(p[i - 1]!, p[i]!, p[j]!) < -1e-15 &&
        side(p[j - 1]!, p[j]!, p[i - 1]!) * side(p[j - 1]!, p[j]!, p[i]!) < -1e-15) return true;
  }
  return false;
}
