type Point = readonly [number, number];
const RAD = Math.PI / 180;

export function compassDirection(point: Point, target: Point): string {
  const lat1 = point[1] * RAD, lat2 = target[1] * RAD, delta = (target[0] - point[0]) * RAD;
  const bearing = (Math.atan2(Math.sin(delta) * Math.cos(lat2),
    Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(delta)) / RAD + 360) % 360;
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(bearing / 45) % 8]!;
}

/** AWC boxes use south, west, north, east. Split at the dateline; filter the circle after fetching. */
export function proximityBoxes([longitude, latitude]: Point, radiusNm: number): string[] {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(latitude) > 90) return [];
  const radius = radiusNm / 3440.065;
  const lat = latitude * RAD;
  const south = Math.max(-90, latitude - radius / RAD), north = Math.min(90, latitude + radius / RAD);
  const box = (west: number, east: number) => [south, west, north, east].join(',');
  if (Math.abs(lat) + radius >= Math.PI / 2) return [box(-180, 180)];
  const span = Math.asin(Math.sin(radius) / Math.cos(lat)) / RAD;
  const center = ((longitude + 180) % 360 + 360) % 360 - 180;
  const west = center - span, east = center + span;
  return west < -180 ? [box(west + 360, 180), box(-180, east)]
    : east > 180 ? [box(west, 180), box(-180, east - 360)] : [box(west, east)];
}
