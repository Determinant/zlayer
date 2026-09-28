import type { PointGeometry } from '@zlayer/contracts';
import type { RouteLeg } from './route-model.js';

type Coordinate = PointGeometry['coordinates'];
const RAD = Math.PI / 180;
const RADIUS_NM = 3440.065;
const MAX_STEP_NM = 20;

/** Bounded spherical interpolation shared by the map, fitting and terrain corridor. */
export function greatCircleCoordinates(from: Coordinate, to: Coordinate): Coordinate[] {
  const vector = ([lon, lat]: Coordinate) => [Math.cos(lat * RAD) * Math.cos(lon * RAD),
    Math.cos(lat * RAD) * Math.sin(lon * RAD), Math.sin(lat * RAD)] as const;
  const a = vector(from), b = vector(to);
  const dot = Math.max(-1, Math.min(1, a.reduce((sum, value, i) => sum + value * b[i]!, 0)));
  let tangent = b.map((value, i) => value - dot * a[i]!);
  let length = Math.hypot(...tangent);
  const angle = Math.atan2(length, dot);
  const steps = Math.ceil(angle * RADIUS_NM / MAX_STEP_NM);
  if (steps <= 1) return [from, to];
  // Exactly antipodal endpoints have no unique course. Choose a stable plane.
  if (length < 1e-12) {
    const axis = Math.abs(a[2]) < .9 ? [0, 0, 1] : [1, 0, 0];
    const projection = a.reduce((sum, value, i) => sum + value * axis[i]!, 0);
    tangent = axis.map((value, i) => value - projection * a[i]!);
    length = Math.hypot(...tangent);
  }
  const result: Coordinate[] = [from];
  for (let i = 1; i < steps; i++) {
    const fraction = angle * i / steps;
    const p = a.map((value, j) => value * Math.cos(fraction) + tangent[j]! / length * Math.sin(fraction));
    result.push([Math.atan2(p[1]!, p[0]!) / RAD, Math.atan2(p[2]!, Math.hypot(p[0]!, p[1]!)) / RAD]);
  }
  result.push(to);
  return result;
}

const paths = new WeakMap<RouteLeg, Coordinate[]>();
export function routeLegCoordinates(leg: RouteLeg): Coordinate[] {
  if (leg.geometry) return leg.geometry;
  let path = paths.get(leg);
  if (!path) {
    path = greatCircleCoordinates(leg.from.feature.geometry.coordinates, leg.to.feature.geometry.coordinates);
    paths.set(leg, path);
  }
  return path;
}
