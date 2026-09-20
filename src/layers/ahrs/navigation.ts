import { clamp, cross, dot, norm, scale, sub, unit, wrap, RAD, type Vec3 } from './estimator/math';

export type Position = readonly [longitude: number, latitude: number];
export type HsiLeg = { key: string; from: string; to: string; start: Position; end: Position };
export type HsiGuidance = {
  leg: HsiLeg;
  course: number;
  distanceNm: number;
  /** Positive means the aircraft is right of the directed route. */
  crossTrackNm: number;
  /** Positive moves the CDI right in the course pointer's frame. */
  deviation: number;
  from: boolean;
  segmentDistanceNm: number;
};
export const HSI_FULL_SCALE_NM = 2;
const EARTH_NM = 6_371_008.8 / 1852;

export function validPosition(value: Position | undefined | null): value is Position {
  return value != null && value.length === 2 && value.every(Number.isFinite) &&
    Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;
}
const vector = ([longitude, latitude]: Position): Vec3 => {
  const lon = longitude * RAD, lat = latitude * RAD;
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
};
const angle = (a: Vec3, b: Vec3) => Math.atan2(norm(cross(a, b)), clamp(dot(a, b), -1, 1));

/** Great-circle lateral guidance; handles the dateline without longitude unwrapping.
 * This is a fixed-scale route display, without procedure or approach sequencing.
 */
export function legGuidance(leg: HsiLeg, position: Position): HsiGuidance | null {
  if (![leg.start, leg.end, position].every(validPosition)) return null;
  const a = vector(leg.start), b = vector(leg.end), p = vector(position);
  const normal = cross(a, b);
  // Coincident and antipodal endpoints do not define a unique usable course.
  if (norm(normal) < 1e-8) return null;
  const n = unit(normal), projection = sub(p, scale(n, dot(p, n)));
  if (norm(projection) < 1e-8) return null;
  const foot = unit(projection), tangent = cross(n, foot);
  const along = Math.atan2(dot(cross(a, foot), n), dot(a, foot));
  const length = angle(a, b), distanceNm = angle(p, b) * EARTH_NM;
  const crossTrackNm = -Math.asin(clamp(dot(p, n), -1, 1)) * EARTH_NM;
  const lon = position[0] * RAD, lat = position[1] * RAD;
  const east: Vec3 = [-Math.sin(lon), Math.cos(lon), 0];
  const north: Vec3 = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)];
  return { leg, course: wrap(Math.atan2(dot(tangent, east), dot(tangent, north)) / RAD),
    distanceNm, crossTrackNm, deviation: clamp(-crossTrackNm / HSI_FULL_SCALE_NM, -1, 1),
    from: along >= length,
    segmentDistanceNm: along >= 0 && along <= length ? Math.abs(crossTrackNm)
      : Math.min(angle(p, a) * EARTH_NM, distanceNm) };
}

/** Geometrically nearest resolved leg. Track breaks ties at shared waypoints.
 * The UI explicitly labels this mode and lets the pilot select a leg instead.
 */
export function nearestLeg(legs: readonly HsiLeg[], position: Position, track: number | null): HsiGuidance | null {
  const difference = (course: number) => track === null ? 0 : Math.abs(((course - track + 540) % 360) - 180);
  let best: HsiGuidance | null = null;
  for (const leg of legs) {
    const candidate = legGuidance(leg, position);
    if (!candidate) continue;
    const delta = candidate.segmentDistanceNm - (best?.segmentDistanceNm ?? Infinity);
    if (!best || delta < -.02 || (Math.abs(delta) <= .02 && difference(candidate.course) < difference(best.course))) best = candidate;
  }
  return best;
}
