import { hasUniqueStrings, isIsoDate, isNonEmptyString as text, isRecord } from './validation.js';

export type ApproachCoordinate = [number, number];
export type ApproachFix = { ident: string; coordinate: ApproachCoordinate; role?: 'IAF' | 'IF' | 'FAF' | 'MAP' };
/** Coded legs retain discontinuities; altitude/vector legs have no invented endpoint. */
export type ApproachLeg = {
  path: string;
  fix?: ApproachFix;
  missed?: boolean;
  turn?: 'L' | 'R';
  magneticCourse?: number;
  /** Course explicitly published in degrees true (the CIFP T suffix). */
  trueCourse?: number;
  distance?: number;
  /** Hx inbound leg duration, in minutes; never a distance. */
  holdMinutes?: number;
  center?: ApproachCoordinate;
  /** Published DME radius for AF legs, in nautical miles; distinct from leg distance. */
  radiusNm?: number;
};
export type ApproachRoute = {
  id: string;
  airport: string;
  ident: string;
  /** Airport magnetic variation of record, east positive, for planning symbols. */
  magneticVariation?: number;
  transitions: { id: string; legs: ApproachLeg[] }[];
  final: ApproachLeg[];
};
export type ApproachRoutesData = {
  type: 'ZLayerApproachRoutes';
  metadata: { effectiveDate: string; source: string };
  procedures: ApproachRoute[];
};

function coordinate(value: unknown): value is ApproachCoordinate {
  return Array.isArray(value) && value.length === 2 && value.every(Number.isFinite) &&
    Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;
}
function leg(value: unknown): value is ApproachLeg {
  return isRecord(value) && typeof value.path === 'string' && /^[A-Z]{2}$/.test(value.path) &&
    (value.fix === undefined || (isRecord(value.fix) && text(value.fix.ident) && coordinate(value.fix.coordinate) &&
      (value.fix.role === undefined || ['IAF', 'IF', 'FAF', 'MAP'].includes(String(value.fix.role))))) &&
    (value.missed === undefined || typeof value.missed === 'boolean') &&
    (value.turn === undefined || value.turn === 'L' || value.turn === 'R') &&
    (value.magneticCourse === undefined || typeof value.magneticCourse === 'number' && Number.isFinite(value.magneticCourse) && value.magneticCourse >= 0 && value.magneticCourse < 360) &&
    (value.trueCourse === undefined || typeof value.trueCourse === 'number' && Number.isFinite(value.trueCourse) && value.trueCourse >= 0 && value.trueCourse < 360) &&
    !(value.trueCourse !== undefined && value.magneticCourse !== undefined) &&
    (value.distance === undefined || typeof value.distance === 'number' && Number.isFinite(value.distance) && value.distance > 0) &&
    (value.holdMinutes === undefined || typeof value.holdMinutes === 'number' && Number.isFinite(value.holdMinutes) && value.holdMinutes > 0) &&
    (value.center === undefined || coordinate(value.center)) &&
    (value.radiusNm === undefined || typeof value.radiusNm === 'number' && Number.isFinite(value.radiusNm) && value.radiusNm > 0);
}
export function isApproachRoutesData(value: unknown, revision?: string): value is ApproachRoutesData {
  return isRecord(value) && value.type === 'ZLayerApproachRoutes' && isRecord(value.metadata) &&
    isIsoDate(value.metadata.effectiveDate) && (revision === undefined || value.metadata.effectiveDate === revision) &&
    text(value.metadata.source) && Array.isArray(value.procedures) && value.procedures.every(p =>
      isRecord(p) && text(p.id) && text(p.airport) && text(p.ident) &&
      (p.magneticVariation === undefined || typeof p.magneticVariation === 'number' && Number.isFinite(p.magneticVariation) && Math.abs(p.magneticVariation) <= 180) &&
      Array.isArray(p.final) && p.final.length > 0 && p.final.every(leg) &&
      Array.isArray(p.transitions) && p.transitions.every(t => isRecord(t) && text(t.id) &&
        Array.isArray(t.legs) && t.legs.length > 0 && t.legs.every(leg)) &&
      hasUniqueStrings(p.transitions.map(t => t.id))) && hasUniqueStrings(value.procedures.map(p => p.id));
}
