import type { GeoPointFeature } from '@zlayer/contracts';
import { featureKey } from '@zlayer/domain';
import type { GlideAirport } from './types';
import { insideViewport, inRouteCorridor, unwrapPoint, type GlideViewport } from './coverage';
import type { Segment } from '../../core/geo/route-corridor';
export const ARRIVAL_RESERVE_FT = 500;
export const TERRAIN_CLEARANCE_FT = 200;
export const FEET_PER_NM = 1852 / 0.3048;

/** Published land runways, including private, turf and gravel. No aircraft-specific
 * landing-distance claim: runway/NOTAM suitability must still be checked. */
export function glideAirport(feature: GeoPointFeature): GlideAirport | undefined {
  const p = feature.properties, kind = String(p.facilityType ?? p.type ?? '').toUpperCase();
  if (!['AIRPORT', 'AIRSTRIP', 'GLIDERPORT', 'A', 'G'].includes(kind)) return;
  const status = String(p.status ?? '').toUpperCase();
  if (status && !['O', 'OP', 'OPEN', 'OPERATIONAL'].includes(status)) return;
  if (!Number.isFinite(p.elevationFt) || !p.runways?.some(runway =>
    (runway.lengthFt ?? 0) > 0 && (runway.widthFt ?? 1) > 0 &&
    !/^H\d|W$/i.test(runway.id) && !/WATER|WTR|CLOSED|CLSD|UNUSABLE/i.test(`${runway.surface ?? ''} ${runway.condition ?? ''}`))) return;
  if (!feature.geometry.coordinates.every(Number.isFinite) || Math.abs(feature.geometry.coordinates[1]) > 80) return;
  return { id: featureKey(feature), coordinate: feature.geometry.coordinates, elevationFt: p.elevationFt!, feature };
}

/** Discover new origins on screen; the planner retains completed ranges off screen. */
export function visibleGlideAirports(features: readonly GeoPointFeature[], viewport: GlideViewport, segments: readonly Segment[], altitude: number, ratio: number): GlideAirport[] {
  if (!segments.length) return [];
  const xs = viewport.map(p => p[0]), ys = viewport.map(p => p[1]);
  const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
  // The cheap metadata filter runs before runway validation and geometry work.
  const result = new Map<string, GlideAirport>();
  for (const feature of features) {
    const point = unwrapPoint(feature.geometry.coordinates, viewport);
    if (point[0] < left || point[0] > right || point[1] < top || point[1] > bottom ||
      !insideViewport(point, viewport) || !inRouteCorridor(point, segments)) continue;
    const airport = glideAirport(feature);
    if (airport && (altitude - airport.elevationFt - ARRIVAL_RESERVE_FT) * ratio > 0) result.set(airport.id, airport);
  }
  return [...result.values()];
}
