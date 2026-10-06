import clipping, { type MultiPolygon } from 'polygon-clipping';
import { distanceNm, greatCircleCoordinates } from '@zlayer/domain';
import type { NotamCoordinate as Point } from './coordinates';
const radians = Math.PI / 180;

export function circle(center: Point, radius: number): Point[] | undefined {
  if (!(radius > 0 && radius <= 600)) return undefined;
  const distance = radius / 3440.065, lat = center[1] * radians;
  // At most 0.01 NM radial chord error, with bounded preparation for broad GPS footprints.
  const count = Math.min(720, Math.max(64, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - .01 / radius)))));
  const ring: Point[] = Array.from({ length: count }, (_, i) => {
    const bearing = -i * 2 * Math.PI / count;
    const next = Math.asin(Math.sin(lat) * Math.cos(distance) + Math.cos(lat) * Math.sin(distance) * Math.cos(bearing));
    const lon = center[0] + Math.atan2(Math.sin(bearing) * Math.sin(distance) * Math.cos(lat), Math.cos(distance) - Math.sin(lat) * Math.sin(next)) / radians;
    return [lon, next / radians];
  });
  if (ring.some(point => Math.abs(point[1]) > 85)) return undefined;
  ring.push([...ring[0]!]); return ring;
}

/** Two-point corridor: constant spherical lateral distance, terminated at the published endpoints. */
function corridorLeg(points: Point[], halfWidthNm: number): Point[] | undefined {
  if (points.length !== 2 || !(halfWidthNm > 0 && halfWidthNm <= 100) ||
      distanceNm(points[0]!, points[1]!) > 600) return;
  const vector = ([lon, lat]: Point) => [Math.cos(lat * radians) * Math.cos(lon * radians),
    Math.cos(lat * radians) * Math.sin(lon * radians), Math.sin(lat * radians)];
  const [a, b] = points.map(vector) as [number[], number[]];
  const normal = [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
  const length = Math.hypot(...normal); if (length < 1e-10) return;
  const path = greatCircleCoordinates(points[0]!, points[1]!);
  const side = (sign: number) => path.map(point => {
    const v = vector(point).map((value, i) => value * Math.cos(halfWidthNm / 3440.065) +
      sign * normal[i]! / length * Math.sin(halfWidthNm / 3440.065));
    return [Math.atan2(v[1]!, v[0]!) / radians, Math.atan2(v[2]!, Math.hypot(v[0]!, v[1]!)) / radians] as Point;
  });
  return polygon([...side(1), ...side(-1).reverse()]);
}

/** Validate the complete boundary before adding great-circle edge samples. */
export function polygon(points: Point[]): Point[] | undefined {
  if (points.length < 3 || points.length > 2048) return undefined;
  const ring = points.filter((p, i) => !i || p.some((v, j) => v !== points[i - 1]![j])).map(([lon, lat]): Point => [points[0]![0] + ((lon - points[0]![0] + 540) % 360 - 180), lat]);
  const same = (a: Point, b: Point) => a[0] === b[0] && a[1] === b[1];
  if (same(ring[0]!, ring.at(-1)!)) ring.pop();
  if (ring.length < 3 || new Set(ring.map(p => p.join(','))).size !== ring.length || ring.some(p => Math.abs(p[1]) > 85) ||
      Math.max(...ring.map(p => p[0])) - Math.min(...ring.map(p => p[0])) >= 180) return undefined;
  ring.push([...ring[0]!]);
  const cross = (a: Point, b: Point, c: Point) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < ring.length - 1; i++) for (let j = i + 2; j < ring.length - 1; j++) {
    if (i === 0 && j === ring.length - 2) continue;
    const a = ring[i]!, b = ring[i + 1]!, c = ring[j]!, d = ring[j + 1]!;
    if (Math.max(a[0], b[0]) >= Math.min(c[0], d[0]) && Math.max(c[0], d[0]) >= Math.min(a[0], b[0]) &&
        Math.max(a[1], b[1]) >= Math.min(c[1], d[1]) && Math.max(c[1], d[1]) >= Math.min(a[1], b[1]) &&
        cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0) return undefined;
  }
  const area = ring.slice(1).reduce((sum, p, i) => sum + ring[i]![0] * p[1] - p[0] * ring[i]![1], 0);
  if (Math.abs(area) < 1e-10) return undefined;
  if (area < 0) ring.reverse();
  if (ring.slice(1).some((p, i) => distanceNm(ring[i]!, p) > 600)) return undefined;
  const detailed = ring.slice(1).flatMap((p, i) => greatCircleCoordinates(ring[i]!, p).slice(0, -1))
    .map(([lon, lat]): Point => [ring[0]![0] + ((lon - ring[0]![0] + 540) % 360 - 180), lat]);
  if (detailed.some(p => Math.abs(p[1]) > 85)) return undefined;
  detailed.push([...detailed[0]!]); return detailed;
}


/** Union leg strips with round interior joins; the published first/last stations have flat caps. */
export function corridor(points: Point[], width: number): MultiPolygon | undefined {
  if (points.length < 2 || points.length > 64) return;
  const parts: MultiPolygon = [];
  const anchor = points[0]![0];
  // Sub-millimeter grid removes floating-point slivers at shared joins before union.
  const unwrap = (ring: Point[]) => ring.map(([lon, lat]): Point => [Math.round((anchor + ((lon - anchor + 540) % 360 - 180)) * 1e9) / 1e9, Math.round(lat * 1e9) / 1e9]);
  for (let i = 1; i < points.length; i++) {
    const ring = corridorLeg([points[i - 1]!, points[i]!], width);
    if (!ring) return;
    parts.push([unwrap(ring)]);
    if (i < points.length - 1 || i === points.length - 1 && distanceNm(points[0]!, points[i]!) < 1e-8) {
      const join = circle(points[i]!, width); if (!join) return;
      parts.push([unwrap(join)]);
    }
  }
  try {
    const result = clipping.union(parts[0]!, ...parts.slice(1));
    return result.length && result.flat(2).length <= 16384 ? result : undefined;
  } catch { return; }
}

export function bearing(from: Point, to: Point): number {
  const lat1 = from[1] * radians, lat2 = to[1] * radians, dlon = (to[0] - from[0]) * radians;
  return (Math.atan2(Math.sin(dlon) * Math.cos(lat2), Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dlon)) / radians + 360) % 360;
}

/** Arc endpoints must corroborate the stated station/radius, to the precision of whole-NM prose. */
export function arc(from: Point, to: Point, center: Point, radius: number, clockwise: boolean): Point[] | undefined {
  if (!(radius > 0 && radius <= 600) || [from, to].some(p => Math.abs(distanceNm(center, p) - radius) > .6)) return;
  const start = bearing(center, from), end = bearing(center, to), sign = clockwise ? 1 : -1;
  const sweep = ((end - start) * sign + 360) % 360;
  if (sweep < 1e-8) return;
  const count = Math.ceil(sweep / 360 * Math.min(720, Math.max(64, Math.ceil(Math.PI / Math.acos(1 - .01 / radius)))));
  const d = radius / 3440.065, lat = center[1] * radians;
  const result: Point[] = [from];
  for (let i = 1; i < count; i++) {
    const angle = (start + sign * sweep * i / count) * radians;
    const next = Math.asin(Math.sin(lat) * Math.cos(d) + Math.cos(lat) * Math.sin(d) * Math.cos(angle));
    result.push([center[0] + Math.atan2(Math.sin(angle) * Math.sin(d) * Math.cos(lat),
      Math.cos(d) - Math.sin(lat) * Math.sin(next)) / radians, next / radians]);
  }
  result.push(to); return result;
}
