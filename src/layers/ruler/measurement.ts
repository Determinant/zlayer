import { distanceNm } from '@zlayer/domain';
import { magneticBearing, magneticField, type MagneticModel } from '../../core/geo/magnetic-model';

export type Coordinate = [longitude: number, latitude: number];
const RAD = Math.PI / 180;
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
  const points: Coordinate[] = [start];
  for (let i = 1; i <= count; i++) {
    const distance = angle * i / count;
    const lat = Math.asin(Math.max(-1, Math.min(1,
      Math.sin(latitude) * Math.cos(distance) + Math.cos(latitude) * Math.sin(distance) * Math.cos(course))));
    const longitude = start[0] + Math.atan2(Math.sin(course) * Math.sin(distance) * Math.cos(latitude),
      Math.cos(distance) - Math.sin(latitude) * Math.sin(lat)) / RAD;
    const point: Coordinate = i === count ? [...end] : [longitude, lat / RAD];
    point[0] += 360 * Math.round((points.at(-1)![0] - point[0]) / 360);
    points.push(point);
  }
  return points;
}
