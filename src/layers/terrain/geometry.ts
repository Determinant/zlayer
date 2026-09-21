import type { RoutePlan } from '@zlayer/domain';

export type Point = [number, number];
export type Segment = [Point, Point];
export type Tile = { z: number; x: number; y: number };
export const INNER_NM = 4;
export const OUTER_NM = 8;
const EARTH_CIRCUMFERENCE_NM = 2 * Math.PI * 6_371_008.8 / 1852;

export function project([lng, lat]: Point): Point {
  const phi = Math.max(-85.051129, Math.min(85.051129, lat)) * Math.PI / 180;
  return [(lng + 180) / 360, (1 - Math.asinh(Math.tan(phi)) / Math.PI) / 2];
}

export function unproject([x, y]: Point): Point {
  return [x * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI];
}

/** Use resolved legs, including airway/procedure expansion; never bridge route gaps. */
export function routeSegments(plans: readonly RoutePlan[]): Segment[] {
  return plans.flatMap(plan => plan.legs.flatMap(leg => {
    const coordinates = leg.geometry ?? [leg.from.feature.geometry.coordinates, leg.to.feature.geometry.coordinates];
    return coordinates.slice(1).map((coordinate, index): Segment => {
      const a = project(coordinates[index]!);
      const b = project(coordinate);
      b[0] += Math.round(a[0] - b[0]);
      return [a, b];
    });
  }));
}

export function distanceToSegment(point: Point, [a, b]: Segment): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy);
}

export function nmPerWorldUnit(y: number): number {
  return EARTH_CIRCUMFERENCE_NM / Math.cosh(Math.PI * (1 - 2 * y));
}

export function corridorDistance(point: Point, segments: readonly Segment[]): number {
  let distance = Infinity;
  for (const segment of segments) distance = Math.min(distance, distanceToSegment(point, segment));
  return distance * nmPerWorldUnit(point[1]);
}

export function corridorOpacity(distanceNm: number): number {
  const t = Math.max(0, Math.min(1, (OUTER_NM - distanceNm) / (OUTER_NM - INNER_NM)));
  return t * t * (3 - 2 * t);
}

/** Conservative tile selection, with world wrapping and rounded leg ends. */
export function segmentsForTile(tile: Tile, segments: readonly Segment[], radiusNm = OUTER_NM): Segment[] {
  const size = 1 / 2 ** tile.z;
  const center: Point = [(tile.x + 0.5) * size, (tile.y + 0.5) * size];
  const scale = Math.min(nmPerWorldUnit(tile.y * size), nmPerWorldUnit((tile.y + 1) * size));
  const radius = radiusNm / scale + Math.SQRT2 * size / 2;
  return segments.flatMap(([a, b]) => {
    const offset = Math.round(center[0] - (a[0] + b[0]) / 2);
    const segment: Segment = [[a[0] + offset, a[1]], [b[0] + offset, b[1]]];
    return distanceToSegment(center, segment) <= radius ? [segment] : [];
  });
}
