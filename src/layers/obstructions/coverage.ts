import type { Bounds } from '@zlayer/contracts';
import { project, unproject } from '../terrain/geometry';
import type { ObstructionCollection } from './types';

function eastOf(west: number, east: number): number { return east < west ? east + 360 : east; }

/** Expand in map space, keeping at most one world's worth of longitudes. */
export function paddedObstructionBounds([west, south, rawEast, north]: Bounds, padding: number): Bounds {
  const east = eastOf(west, rawEast), center = (west + east) / 2;
  const halfWidth = Math.min(180, (east - west) * (0.5 + padding));
  const top = project([0, north])[1], bottom = project([0, south])[1];
  const margin = (bottom - top) * padding;
  return [center - halfWidth, unproject([0, Math.min(1, bottom + margin)])[1],
    center + halfWidth, unproject([0, Math.max(0, top - margin)])[1]];
}

/** Compare equivalent world copies, including bounds crossing the dateline. */
export function obstructionBoundsContain(outer: Bounds, inner: Bounds): boolean {
  const [west, south, rawEast, north] = outer, east = eastOf(west, rawEast);
  const [left, bottom, rawRight, top] = inner, right = eastOf(left, rawRight);
  const shift = 360 * Math.round((west + east - left - right) / 720);
  const epsilon = 1e-9;
  return bottom >= south - epsilon && top <= north + epsilon &&
    (east - west >= 360 - epsilon || (left + shift >= west - epsilon && right + shift <= east + epsilon));
}

/** Buffered points must not inflate the user-facing count for the actual view. */
export function obstructionCountInView(collection: ObstructionCollection, bounds: Bounds, zoom: number): number {
  let count = 0;
  for (const point of collection.features) {
    if (zoom < point.properties.minZoom && point.properties.routeOpacity <= 0) continue;
    const [lon, lat] = point.geometry.coordinates as [number, number];
    if (obstructionBoundsContain(bounds, [lon, lat, lon, lat])) count++;
  }
  return count;
}
