import type { ApproachCoordinate as Coordinate, ApproachLeg, ApproachRoute } from '@zlayer/contracts';
import { distanceNm, geographicMidpoint } from './route.js';

const radians = Math.PI / 180;
export function bearing(a: Coordinate, b: Coordinate): number {
  const delta = (b[0] - a[0]) * radians, lat1 = a[1] * radians, lat2 = b[1] * radians;
  return (Math.atan2(Math.sin(delta) * Math.cos(lat2), Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(delta)) / radians + 360) % 360;
}
export function destination(a: Coordinate, course: number, nm: number): Coordinate {
  const distance = nm / 3440.065, heading = course * radians, lat = a[1] * radians;
  const next = Math.asin(Math.sin(lat) * Math.cos(distance) + Math.cos(lat) * Math.sin(distance) * Math.cos(heading));
  const lon = a[0] + Math.atan2(Math.sin(heading) * Math.sin(distance) * Math.cos(lat), Math.cos(distance) - Math.sin(lat) * Math.sin(next)) / radians;
  return [((lon + 540) % 360) - 180, next / radians];
}
export function radiusArc(from: Coordinate, to: Coordinate, center: Coordinate, turn: 'L' | 'R', radius = distanceNm(center, from)): Coordinate[] | undefined {
  // Allow rounded published distances, but never bridge endpoints on different arcs.
  if (!Number.isFinite(radius) || radius <= 0 || Math.abs(radius - distanceNm(center, from)) > 0.2 ||
      Math.abs(radius - distanceNm(center, to)) > 0.2) return undefined;
  const start = bearing(center, from), end = bearing(center, to);
  const sweep = turn === 'R' ? (end - start + 360) % 360 : -((start - end + 360) % 360);
  const count = Math.max(2, Math.ceil(Math.abs(sweep) / 4));
  return Array.from({ length: count + 1 }, (_, i) => i === 0 ? from : i === count ? to : destination(center, start + sweep * i / count, radius));
}

export function approachCourse(leg: ApproachLeg, procedure: Pick<ApproachRoute, 'magneticVariation'>): number | undefined {
  if (leg.trueCourse !== undefined) return leg.trueCourse;
  const course = leg.magneticCourse;
  if (course === undefined) return undefined;
  const reference = leg.reference;
  // A recommended station can locate a fix without defining the flown course.
  // Only use its alignment when the course follows its radial or starts there.
  if (!leg.path.startsWith('V') && reference?.declination !== undefined) {
    const parallel = leg.radial !== undefined && Math.abs((course - leg.radial + 450) % 180 - 90) < 1;
    const fromStation = ['FC', 'FA', 'PI', 'CF', 'HM', 'HA', 'HF'].includes(leg.path) && leg.fix && reference.coordinate && distanceNm(leg.fix.coordinate, reference.coordinate) < .02;
    if (parallel || fromStation || leg.path === 'PI') {
      if (parallel && leg.path === 'CF' && reference.coordinate && leg.fix && distanceNm(reference.coordinate, leg.fix.coordinate) > .1) {
        const toward = Math.abs((course - leg.radial! + 540) % 360 - 180) > 90;
        return (bearing(leg.fix.coordinate, reference.coordinate) + (toward ? 0 : 180)) % 360;
      }
      return (course + reference.declination + 360) % 360;
    }
  }
  return procedure.magneticVariation === undefined ? undefined : (course + procedure.magneticVariation + 360) % 360;
}

/** Consecutive FC/CF legs on the same published course form one bounded track.
 * Use the surveyed endpoints: a VOR's station declination can differ from the
 * airport variation. Check the coded lengths before treating them as one line.
 */
export function courseFromFix(leg: ApproachLeg, next: ApproachLeg, procedure: Pick<ApproachRoute, 'magneticVariation'>): Coordinate[] | undefined {
  const from = leg.fix?.coordinate, to = next.fix?.coordinate;
  const course = leg.trueCourse ?? leg.magneticCourse, inbound = next.trueCourse ?? next.magneticCourse;
  if (leg.path !== 'FC' || next.path !== 'CF' || !from || !to || !leg.distance || !next.distance ||
      course === undefined || inbound === undefined || (leg.trueCourse === undefined) !== (next.trueCourse === undefined) ||
      Math.abs((course - inbound + 540) % 360 - 180) > 0.1) return undefined;
  const length = distanceNm(from, to);
  if (leg.distance >= length || Math.abs(length - leg.distance - next.distance) > 0.2) return undefined;
  const heading = approachCourse(leg, procedure);
  // Only a direction sanity check: allow station/airport declination differences.
  if (heading === undefined || Math.abs((bearing(from, to) - heading + 540) % 360 - 180) > 10) return undefined;
  return [from, destination(from, bearing(from, to), leg.distance), to];
}

/** No-wind CI/VI preview, bounded by the following CF course and fix. */
export function courseIntercept(from: Coordinate, leg: ApproachLeg, next: ApproachLeg, procedure: Pick<ApproachRoute, 'magneticVariation'>): Coordinate[] | undefined {
  const outbound = approachCourse(leg, procedure), inbound = approachCourse(next, procedure), to = next.fix?.coordinate;
  if (!['CI', 'VI'].includes(leg.path) || leg.fix || next.path !== 'CF' || !to || outbound === undefined || inbound === undefined) return undefined;
  type Vector = [number, number, number];
  const cross = (a: Vector, b: Vector): Vector => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const normal = ([lon, lat]: Coordinate, course: number): Vector => {
    const x = lon * radians, y = lat * radians, h = course * radians;
    const point: Vector = [Math.cos(y) * Math.cos(x), Math.cos(y) * Math.sin(x), Math.sin(y)];
    const tangent: Vector = [-Math.sin(y) * Math.cos(x) * Math.cos(h) - Math.sin(x) * Math.sin(h),
      -Math.sin(y) * Math.sin(x) * Math.cos(h) + Math.cos(x) * Math.sin(h), Math.cos(y) * Math.cos(h)];
    return cross(point, tangent);
  };
  const axis = cross(normal(from, outbound), normal(to, inbound));
  if (Math.hypot(...axis) < 1e-6) return undefined;
  const angle = (a: number, b: number) => Math.abs((a - b + 540) % 360 - 180);
  const limit = Math.min(100, Math.max(10, distanceNm(from, to) * 3));
  for (const sign of [1, -1]) {
    const intersection: Coordinate = [Math.atan2(sign * axis[1], sign * axis[0]) / radians,
      Math.atan2(sign * axis[2], Math.hypot(axis[0], axis[1])) / radians];
    const before = distanceNm(from, intersection), after = distanceNm(to, intersection);
    // Reject intersections behind either ray, beyond the fix or implausibly far away.
    if (before < 0.01 || after < 0.01 || before + after > limit ||
        angle(bearing(from, intersection), outbound) > 0.01 || angle(bearing(to, intersection), (inbound + 180) % 360) > 0.01) continue;
    // A small rounded corner illustrates turn anticipation; it is not a flyable radius.
    const turn = (bearing(intersection, to) - (bearing(intersection, from) + 180) + 540) % 360 - 180;
    if (next.turn && next.turn !== (turn < 0 ? 'L' : 'R')) return undefined;
    const trim = Math.min(0.6, before / 4, after / 4);
    const a = destination(intersection, bearing(intersection, from), trim);
    const b = destination(intersection, bearing(intersection, to), trim);
    const unwrap = (p: Coordinate): Coordinate => [a[0] + ((p[0] - a[0] + 540) % 360 - 180), p[1]];
    const control = unwrap(intersection), end = unwrap(b);
    const curve = Array.from({ length: 12 }, (_, i): Coordinate => {
      const t = (i + 1) / 12, u = 1 - t;
      return [0, 1].map(axis => u * u * a[axis]! + 2 * u * t * control[axis]! + t * t * end[axis]!) as Coordinate;
    });
    return [from, a, ...curve.slice(0, -1), b, to];
  }
  return undefined;
}

export function arrivalBearing(from: Coordinate, to: Coordinate): number | undefined {
  return distanceNm(from, to) < 0.01 ? undefined : (bearing(to, from) + 180) % 360;
}

/** FAA AIM 5-3-8 entry sectors, using planned course at the fix (no wind correction).
 * https://www.faa.gov/air_traffic/publications/atpubs/aim_html/chap5_section_3.html
 * Mirror the standard 70/110/180-degree sectors for a left-hand hold.
 */
export function holdingEntry(inbound: number, arrival: number, turn: 'L' | 'R'): 'Direct' | 'Parallel' | 'Teardrop' {
  const relative = ((arrival - inbound) * (turn === 'R' ? 1 : -1) % 360 + 540) % 360 - 180;
  return relative < -70 ? 'Parallel' : relative > 110 ? 'Teardrop' : 'Direct';
}

/** Oriented racetrack symbol. Turn radius and timed-leg scale are illustrative, not flight guidance. */
export function holdingPattern(leg: ApproachLeg, procedure: Pick<ApproachRoute, 'magneticVariation'>): {
  coordinates: Coordinate[]; arrow: { coordinate: Coordinate; bearing: number };
} | undefined {
  const inbound = approachCourse(leg, procedure), fix = leg.fix?.coordinate;
  if (inbound === undefined || !fix || !leg.turn) return undefined;
  // Distance-coded straight legs retain their length. Timed holds use a fixed drawing scale.
  const length = leg.distance ?? (leg.holdMinutes === undefined ? undefined : leg.holdMinutes * 3);
  if (!length) return undefined;
  const radius = Math.min(0.8, length / 4), side = leg.turn === 'R' ? 1 : -1;
  const point = (along: number, right: number) => destination(fix, inbound + Math.atan2(right, along) / radians, Math.hypot(along, right));
  const first = Array.from({ length: 25 }, (_, i) => {
    const angle = i * Math.PI / 24;
    return point(radius * Math.sin(angle), side * radius * (1 - Math.cos(angle)));
  });
  const second = Array.from({ length: 25 }, (_, i) => {
    const angle = i * Math.PI / 24;
    return point(-length - radius * Math.sin(angle), side * radius * (1 + Math.cos(angle)));
  });
  const coordinate = geographicMidpoint(first.at(-1)!, second[0]!);
  return { coordinates: [fix, ...first.slice(1), ...second, fix],
    arrow: { coordinate, bearing: bearing(coordinate, second[0]!) } };
}
