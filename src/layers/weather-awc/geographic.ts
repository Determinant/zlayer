/** Geographic degrees, in GeoJSON order. Unwrapped paths may use other world
 * copies; canonical positions use [-180, 180). A split boundary may use +180. */
export type GeographicPosition = [longitude: number, latitude: number];

/** Inputs have already passed the product's finite-coordinate bounds. Remainder
 * avoids the rounding in (longitude + 180) at the representable values next to
 * the date line; that formula can produce a result just outside [-180, 180). */
export function wrapLongitude(longitude: number): number {
  const wrapped = longitude % 360;
  return wrapped < -180 ? wrapped + 360 : wrapped >= 180 ? wrapped - 360 : wrapped;
}

/** Select the nearest world copy. An exact 180-degree tie chooses the eastern
 * copy, matching AWC curves. Advisory ingestion rejects that ambiguous edge. */
export function longitudeNear(longitude: number, reference: number): number {
  return longitude + 360 * Math.round((reference - longitude) / 360);
}

/** Split a shortest edge between canonical positions, preserving its direction.
 * The two seam positions name the same location. This is linear interpolation
 * in geographic degrees, not a great-circle or projected-grid calculation.
 * Product adapters own duplicate points, line-size limits and polygon topology. */
export function dateLineCrossing(a: GeographicPosition, b: GeographicPosition):
  { leaving: GeographicPosition; entering: GeographicPosition } | undefined {
  if (Math.abs(b[0] - a[0]) <= 180) return;
  const longitude = b[0] + (b[0] > a[0] ? -360 : 360), edge = b[0] > a[0] ? -180 : 180;
  // Exact seam endpoints must keep the supplied latitude, including when
  // subtracting and adding large, opposite-signed latitudes would round it.
  const latitude = edge === a[0] ? a[1] : edge === longitude ? b[1]
    : a[1] + (b[1] - a[1]) * (edge - a[0]) / (longitude - a[0]);
  return { leaving: [edge, latitude], entering: [-edge, latitude] };
}
