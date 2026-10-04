import { distanceNm } from '@zlayer/domain';
import { magneticBearing, magneticField, type MagneticModel } from '../../core/geo/magnetic-model';

export type Coordinate = [longitude: number, latitude: number];
const RAD = Math.PI / 180;
const PATH_MAX_POINTS = 8192;
// Half a CSS pixel at the workspace's maximum zoom (13), with 512-pixel worlds.
const PATH_TOLERANCE = 0.5 / (512 * 2 ** 13);
const wrap = (degrees: number) => ((degrees % 360) + 360) % 360;

export function normalizeCoordinate([longitude, latitude]: Coordinate): Coordinate | null {
  return Number.isFinite(longitude) && Number.isFinite(latitude) && Math.abs(latitude) <= 90
    ? [wrap(longitude + 180) - 180, latitude] : null;
}

/** Initial great-circle bearing. Coincident/antipodal points have no unique course. */
export function initialBearing(start: Coordinate, end: Coordinate): number | null {
  const delta = (end[0] - start[0]) * RAD, a = start[1] * RAD, b = end[1] * RAD;
  const x = Math.sin(delta) * Math.cos(b);
  const y = Math.cos(a) * Math.sin(b) - Math.sin(a) * Math.cos(b) * Math.cos(delta);
  return Math.hypot(x, y) < 1e-10 || Math.abs(start[1]) === 90 ? null : wrap(Math.atan2(x, y) / RAD);
}

export function measure(start: Coordinate, end: Coordinate, model: MagneticModel | null, time = Date.now()) {
  const distance = distanceNm(start, end), trueBearing = initialBearing(start, end);
  const field = model ? magneticField(model, start, 0, time) : null;
  const magnetic = field !== null && field.horizontal >= 6000 && Math.abs(start[1]) < 90;
  return {
    distance,
    trueBearing,
    bearing: trueBearing === null ? null : magnetic ? magneticBearing(trueBearing, field.declination) : trueBearing,
    magnetic,
  };
}

export const formatDistance = (distance: number) => distance < 10 ? distance.toFixed(2) : distance.toFixed(1);
export const formatBearing = (bearing: number | null, magnetic: boolean) => bearing === null ? '—'
  : `${String(Math.round(bearing) % 360).padStart(3, '0')}°${magnetic ? 'M' : 'T'}`;

/** Sample the same great circle as the distance, keeping one continuous world copy. */
export function rulerPath(start: Coordinate, end: Coordinate): Coordinate[] {
  const bearing = initialBearing(start, end);
  if (bearing === null) return [];
  const angle = distanceNm(start, end) / 3440.065;
  const count = Math.max(1, Math.ceil(angle / RAD));
  const latitude = start[1] * RAD, course = bearing * RAD;
  const sample = (fraction: number): Coordinate => {
    if (fraction === 0) return start;
    if (fraction === 1) return [...end];
    const distance = angle * fraction;
    const lat = Math.asin(Math.max(-1, Math.min(1,
      Math.sin(latitude) * Math.cos(distance) + Math.cos(latitude) * Math.sin(distance) * Math.cos(course))));
    const longitude = start[0] + Math.atan2(Math.sin(course) * Math.sin(distance) * Math.cos(latitude),
      Math.cos(distance) - Math.sin(latitude) * Math.sin(lat)) / RAD;
    return [longitude, lat / RAD];
  };
  const near = (point: Coordinate, longitude: number): Coordinate =>
    [point[0] + 360 * Math.round((longitude - point[0]) / 360), point[1]];
  const project = ([longitude, latitude]: Coordinate): Coordinate => {
    const lat = Math.max(-85.051129, Math.min(85.051129, latitude)) * RAD;
    return [longitude / 360, -Math.log(Math.tan(Math.PI / 4 + lat / 2)) / (2 * Math.PI)];
  };
  type Edge = { from: number; to: number; a: Coordinate; b: Coordinate; depth: number };
  const edges: Edge[] = [];
  let a = start;
  for (let i = 1; i <= count; i++) {
    const b = near(sample(i / count), a[0]);
    edges.push({ from: (i - 1) / count, to: i / count, a, b, depth: 0 }); a = b;
  }
  const pending = edges.reverse(), points: Coordinate[] = [start];
  while (pending.length) {
    const edge = pending.pop()!, { from, to, a, b, depth } = edge;
    const middle = (from + to) / 2, midpoint = near(sample(middle), (a[0] + b[0]) / 2);
    const pa = project(a), pb = project(b);
    const dx = pb[0] - pa[0], dy = pb[1] - pa[1], lengthSquared = dx * dx + dy * dy;
    // Check quarters too: a midpoint alone can miss a change in curvature.
    const error = [0.25, 0.5, 0.75].some(fraction => {
      const point = fraction === 0.5 ? midpoint : near(sample(from + (to - from) * fraction), a[0] + (b[0] - a[0]) * fraction);
      const p = project(point);
      const t = lengthSquared ? Math.max(0, Math.min(1, ((p[0] - pa[0]) * dx + (p[1] - pa[1]) * dy) / lengthSquared)) : 0;
      return Math.hypot(p[0] - pa[0] - dx * t, p[1] - pa[1] - dy * t) > PATH_TOLERANCE;
    });
    // Reserve every pending endpoint, including the exact requested end.
    if (error && depth < 12 && points.length + pending.length + 2 < PATH_MAX_POINTS) {
      pending.push({ from: middle, to, a: midpoint, b, depth: depth + 1 },
        { from, to: middle, a, b: midpoint, depth: depth + 1 });
    } else points.push(b);
  }
  return points;
}
