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

export function approachCourse(leg: ApproachLeg, procedure: ApproachRoute): number | undefined {
  return leg.trueCourse ?? (leg.magneticCourse !== undefined && procedure.magneticVariation !== undefined
    ? (leg.magneticCourse + procedure.magneticVariation + 360) % 360 : undefined);
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
export function holdingPattern(leg: ApproachLeg, procedure: ApproachRoute): {
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

/** Illustrate an altitude-terminated climb, optional bounded intercept, and next fix. */
export function missedClimb(from: Coordinate, climb: ApproachLeg, next: ApproachLeg, procedure: ApproachRoute, intercept?: ApproachLeg): Coordinate[] | undefined {
  const outbound = approachCourse(climb, procedure), to = next.fix?.coordinate;
  if (outbound === undefined || !to || !['TF', 'CF', 'DF'].includes(next.path)) return undefined;
  if (intercept && (intercept.fix || !['VI', 'CI'].includes(intercept.path) || next.path !== 'CF')) return undefined;
  const distance = distanceNm(from, to);
  if (distance < 0.1) return undefined;
  const start = destination(from, outbound, Math.min(1.5, distance / 4));
  const inbound = next.path === 'CF' ? approachCourse(next, procedure) : bearing(start, to);
  if (inbound === undefined) return undefined;
  const heading = intercept ? approachCourse(intercept, procedure) : inbound;
  if (heading === undefined) return undefined;
  const shortest = (heading - outbound + 540) % 360 - 180, direction = (intercept ?? next).turn;
  const side = direction === 'R' ? 1 : direction === 'L' ? -1 : shortest < 0 ? -1 : 1;
  const sweep = side > 0 ? (heading - outbound + 360) % 360 : -((outbound - heading + 360) % 360);
  const radius = Math.min(0.7, distance / 8), center = destination(start, outbound + side * 90, radius);
  const count = Math.max(1, Math.ceil(Math.abs(sweep) / 6));
  const turn = Array.from({ length: count + 1 }, (_, i) => destination(center, outbound - side * 90 + sweep * i / count, radius));
  if (intercept) turn.push(destination(turn.at(-1)!, heading, Math.min(1.5, distance / 8)));
  const end = turn.at(-1)!;
  // Climb length and intercept position depend on altitude, wind and aircraft.
  // Show the intervening heading and a smooth join onto the known inbound course,
  // without claiming an exact geographic intersection or creating a route leg.
  const target = intercept ? destination(to, inbound + 180, Math.min(distance, distanceNm(end, to)) / 2) : to;
  const control = Math.min(2, distanceNm(end, target) / 3);
  const a = destination(end, heading, control), b = destination(target, inbound + 180, control);
  // Unwrap longitudes while interpolating so date-line procedures stay local.
  const unwrap = (p: Coordinate): Coordinate => [end[0] + ((p[0] - end[0] + 540) % 360 - 180), p[1]];
  const controls = [end, unwrap(a), unwrap(b), unwrap(target)];
  const join = Array.from({ length: 24 }, (_, i): Coordinate => {
    const t = (i + 1) / 24, u = 1 - t, weights = [u ** 3, 3 * u * u * t, 3 * u * t * t, t ** 3];
    return [0, 1].map(axis => controls.reduce((sum, p, j) => sum + p[axis]! * weights[j]!, 0)) as Coordinate;
  });
  return [from, start, ...turn.slice(1), ...join.slice(0, -1), target, ...(intercept ? [to] : [])];
}
