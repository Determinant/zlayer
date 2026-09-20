import type { PointGeometry } from '@zlayer/contracts';

/** Keep consecutive points in the same world copy across the antimeridian.
 * MapLibre wraps the resulting line; fitting uses the identical longitude rule. */
export function unwrapRouteCoordinates(
  coordinates: readonly PointGeometry['coordinates'][],
  referenceLongitude = coordinates[0]?.[0] ?? 0,
): PointGeometry['coordinates'][] {
  let previous = referenceLongitude;
  return coordinates.map(([longitude, latitude]) => {
    const unwrapped = longitude + 360 * Math.round((previous - longitude) / 360);
    previous = unwrapped;
    return [unwrapped, latitude];
  });
}
