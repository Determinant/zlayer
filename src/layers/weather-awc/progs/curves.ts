type Position = [number, number];

/** AWC's surface renderer uses a cardinal spline in latitude/longitude with
 * tension 0.5, 16 subdivisions, and duplicated endpoint controls. Prepare it
 * once on the server; this is spatial styling, never interpolation in time.
 * Reference: https://aviationweather.gov/assets/map-BY_ek-uh.js (2026-09-24).
 */
export function surfaceLineCurve(coordinates: readonly Position[]): Position[] {
  const segments = 16;
  if (coordinates.length < 2 || (coordinates.length - 1) * segments + 1 > 5000) throw new Error('Surface curve exceeds its position limit');
  // Work continuously across ±180° before wrapping/splitting the finished curve.
  const points: Position[] = [];
  for (const [longitude, latitude] of coordinates) {
    const previous = points.at(-1)?.[0] ?? longitude;
    points.push([longitude + 360 * Math.round((previous - longitude) / 360), latitude]);
  }
  const result: Position[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[Math.max(0, i - 1)]!, b = points[i]!, c = points[i + 1]!, d = points[Math.min(points.length - 1, i + 2)]!;
    result.push([...b]);
    for (let j = 1; j < segments; j++) {
      const t = j / segments, t2 = t * t, t3 = t2 * t;
      const start = 2 * t3 - 3 * t2 + 1, end = -2 * t3 + 3 * t2;
      const outgoing = (t3 - 2 * t2 + t) / 2, incoming = (t3 - t2) / 2;
      const point = (axis: 0 | 1) => Math.round((start * b[axis] + end * c[axis] + outgoing * (c[axis] - a[axis]) + incoming * (d[axis] - b[axis])) * 1e5) / 1e5;
      result.push([point(0), point(1)]);
    }
  }
  result.push([...points.at(-1)!]);
  return result.map(([longitude, latitude]) => {
    if (Math.abs(latitude) > 90) throw new Error('Invalid surface curve latitude');
    return [longitude - 360 * Math.floor((longitude + 180) / 360), latitude];
  });
}
