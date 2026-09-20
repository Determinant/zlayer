import type { GeoPointFeature, PointGeometry } from '@zlayer/contracts';

/** Compact degrees/minutes/seconds keeps coordinates intact through route delimiters. */
export function routeCoordinateFeature(coordinates: PointGeometry['coordinates']): GeoPointFeature {
  const [longitude, latitude] = coordinates;
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(latitude) > 90) {
    throw new RangeError('Invalid route coordinate');
  }
  const wrappedLongitude = ((longitude + 180) % 360 + 360) % 360 - 180;
  const ident = `${formatAngle(latitude, 2)}${latitude < 0 ? 'S' : 'N'}` +
    `${formatAngle(wrappedLongitude, 3)}${wrappedLongitude < 0 ? 'W' : 'E'}`;
  const feature = parseRouteCoordinate(ident);
  if (!feature) throw new RangeError('Invalid route coordinate');
  return feature;
}

export function parseRouteCoordinate(token: string): GeoPointFeature | undefined {
  const match = /^(\d{2})(\d{2})(\d{2})([NS])(\d{3})(\d{2})(\d{2})([EW])$/.exec(token);
  if (!match) return undefined;
  const latitude = parseAngle(match[1]!, match[2]!, match[3]!, 90);
  const longitude = parseAngle(match[5]!, match[6]!, match[7]!, 180);
  if (latitude === undefined || longitude === undefined) return undefined;
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [
      longitude === 0 ? 0 : longitude * (match[8] === 'W' ? -1 : 1),
      latitude === 0 ? 0 : latitude * (match[4] === 'S' ? -1 : 1),
    ] },
    // No feature pin: the coordinate is self-contained and needs no navigation data.
    properties: { kind: 'coordinate', ident: token, name: 'GPS waypoint' },
  };
}

/** Recover GPS geometry from its identifier after map tiling or selection persistence. */
export function restoreRouteCoordinate(feature: GeoPointFeature): GeoPointFeature {
  const coordinate = feature.properties.kind === 'coordinate'
    ? parseRouteCoordinate(feature.properties.ident ?? '') : undefined;
  if (!coordinate || coordinate.geometry.coordinates.every((value, index) => value === feature.geometry.coordinates[index])) {
    return feature;
  }
  return { ...feature, geometry: coordinate.geometry };
}

function formatAngle(value: number, degreeDigits: number): string {
  const seconds = Math.round(Math.abs(value) * 3600);
  return String(Math.floor(seconds / 3600)).padStart(degreeDigits, '0') +
    String(Math.floor(seconds / 60) % 60).padStart(2, '0') + String(seconds % 60).padStart(2, '0');
}

function parseAngle(degrees: string, minutes: string, seconds: string, limit: number): number | undefined {
  const value = Number(degrees) + Number(minutes) / 60 + Number(seconds) / 3600;
  return Number(minutes) < 60 && Number(seconds) < 60 && value <= limit ? value : undefined;
}
