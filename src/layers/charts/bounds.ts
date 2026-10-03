import type { Bounds } from '@zlayer/contracts';

/** Legacy chart footprints may cross the dateline; viewports can use any world copy.
 * Edge-only contact has no pixels and must not affect package zoom selection. */
export function chartBoundsIntersect([chartWest, chartSouth, chartEast, chartNorth]: Bounds,
  [west, south, east, north]: Bounds): boolean {
  if (south >= chartNorth || north <= chartSouth) return false;
  if (chartEast < chartWest) chartEast += 360;
  if (east < west) east += 360;
  const firstWorld = Math.floor((west - chartEast) / 360) + 1;
  return chartWest + firstWorld * 360 < east;
}
