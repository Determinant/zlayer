import type { GeoPointFeature, PointGeometry } from '@zlayer/contracts';
import { distanceNm } from './route.js';
import { isMonVor } from './mon-vors.js';
import { normalizeNavaidType } from './navaids.js';
export { MON_VOR_REFERENCE_DATE } from './mon-vors.js';

export const NEARBY_VOR_RADIUS_NM = 100;
export const NEARBY_VOR_MAP_LIMIT = 3;
const VOR_TYPES = new Set(['VOR', 'VOR/DME', 'VORTAC']);
const RADIANS = Math.PI / 180;

export type NearbyVor = {
  feature: GeoPointFeature;
  distanceNm: number;
  trueBearing: number | null;
  /** Magnetic radial FROM the station, or null when its published alignment is missing. */
  radial: number | null;
  mon: boolean;
};

/** Geographic references, independent of chart visibility or radio reception. */
export function nearbyVorStations(point: PointGeometry['coordinates'], navaids: readonly GeoPointFeature[]): NearbyVor[] {
  return navaids.flatMap((feature): NearbyVor[] => {
    const { type, status, stationDeclinationDeg } = feature.properties;
    if (!VOR_TYPES.has(normalizeNavaidType(type))) return [];
    if (typeof status === 'string' && status.trim() && !/^OPERATIONAL(?:\s|$)/i.test(status.trim())) return [];
    const distance = distanceNm(feature.geometry.coordinates, point);
    // A station at the selected point cannot provide a useful radial to itself.
    if (!Number.isFinite(distance) || distance < 0.05 || distance > NEARBY_VOR_RADIUS_NM) return [];
    // A radial is FROM the station, using its published alignment.
    const trueBearing = bearingFrom(feature.geometry.coordinates, point);
    const variation = typeof stationDeclinationDeg === 'number' && Number.isFinite(stationDeclinationDeg)
      && Math.abs(stationDeclinationDeg) <= 180 ? stationDeclinationDeg : undefined;
    return [{ feature, distanceNm: distance, trueBearing, mon: isMonVor(feature),
      radial: variation !== undefined ? normalize(trueBearing - variation) : null }];
  }).sort((a, b) => {
    const aPenalty = distancePenalty(a.distanceNm), bPenalty = distancePenalty(b.distanceNm);
    // Prefer the useful 5–60 NM band, then MON candidates and nearest distance.
    // Outside that band, use the stations closest to the band as fallbacks.
    return Number(aPenalty > 0) - Number(bPenalty > 0) || aPenalty - bPenalty ||
      Number(b.mon) - Number(a.mon) || a.distanceNm - b.distanceNm ||
      String(a.feature.id ?? a.feature.properties.ident).localeCompare(String(b.feature.id ?? b.feature.properties.ident));
  }).slice(0, 6);
}

const distancePenalty = (distance: number) => Math.max(5 - distance, distance - 60, 0);

function bearingFrom(from: PointGeometry['coordinates'], to: PointGeometry['coordinates']): number {
  const latitude1 = from[1] * RADIANS, latitude2 = to[1] * RADIANS;
  const longitudeDelta = (to[0] - from[0]) * RADIANS;
  return normalize(Math.atan2(Math.sin(longitudeDelta) * Math.cos(latitude2),
    Math.cos(latitude1) * Math.sin(latitude2) - Math.sin(latitude1) * Math.cos(latitude2) * Math.cos(longitudeDelta)) / RADIANS);
}

const normalize = (degrees: number) => (degrees % 360 + 360) % 360;
