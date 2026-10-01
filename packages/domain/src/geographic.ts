import type { PointGeometry } from '@zlayer/contracts';

const EARTH_RADIUS_NM = 3_440.065;

export function distanceNm(
  from: PointGeometry['coordinates'],
  to: PointGeometry['coordinates'],
): number {
  const latitude1 = degreesToRadians(from[1]);
  const latitude2 = degreesToRadians(to[1]);
  const latitudeDelta = latitude2 - latitude1;
  const longitudeDelta = degreesToRadians(to[0] - from[0]);
  const haversine = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

export function geographicMidpoint(
  from: PointGeometry['coordinates'],
  to: PointGeometry['coordinates'],
): PointGeometry['coordinates'] {
  const latitude1 = degreesToRadians(from[1]);
  const longitude1 = degreesToRadians(from[0]);
  const latitude2 = degreesToRadians(to[1]);
  const longitudeDelta = degreesToRadians(to[0] - from[0]);
  const x = Math.cos(latitude2) * Math.cos(longitudeDelta);
  const y = Math.cos(latitude2) * Math.sin(longitudeDelta);
  const latitude = Math.atan2(
    Math.sin(latitude1) + Math.sin(latitude2),
    Math.sqrt((Math.cos(latitude1) + x) ** 2 + y ** 2),
  );
  const longitude = longitude1 + Math.atan2(y, Math.cos(latitude1) + x);
  return [normalizeLongitude(radiansToDegrees(longitude)), radiansToDegrees(latitude)];
}

function normalizeLongitude(longitude: number): number {
  return ((longitude + 540) % 360) - 180;
}

function degreesToRadians(value: number): number {
  return value * Math.PI / 180;
}

function radiansToDegrees(value: number): number {
  return value * 180 / Math.PI;
}
