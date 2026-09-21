import { hasUniqueStrings, isIsoDate, isNonEmptyString as text, isRecord } from './validation.js';

export type ApproachCoordinate = [number, number];
export type ApproachFix = { ident: string; coordinate: ApproachCoordinate; role?: 'IAF' | 'IF' | 'FAF' | 'MAP' };
export type ApproachReference = {
  /** Scoped ARINC identity, including airport for terminal facilities. */
  id: string;
  ident: string;
  type: 'navaid' | 'localizer';
  coordinate?: ApproachCoordinate;
  dmeCoordinate?: ApproachCoordinate;
  /** Published station alignment, east positive; not current regional variation. */
  declination?: number;
};
/** Coded legs retain discontinuities; altitude/vector legs have no invented endpoint. */
export type ApproachLeg = {
  path: string;
  /** Source branch and sequence; stable within an edition. */
  id?: string;
  sourceFix?: { id: string; ident: string };
  rnpNm?: number;
  speed?: { knots: number; restriction: string };
  verticalAngle?: number;
  transitionAltitude?: string;
  turnDirectionValid?: boolean;
  gnssFms?: string;
  qualifiers?: string;
  continuations?: { number: string; application: string; raw: string;
    services?: { authorization: string; name: string }[] }[];
  reference?: ApproachReference;
  /** ARINC theta/rho, distinct from the flown course and leg distance. */
  radial?: number;
  rhoNm?: number;
  /** Preserve the source constraint, including FL versus feet, without inventing a trajectory. */
  altitude?: { restriction: string; first: string; second: string };
  waypointDescriptor?: string;
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
  /** Published AF DME radius or RF arc radius, in nautical miles; distinct from leg distance. */
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
  metadata: { effectiveDate: string; source: string; schemaVersion?: 2 };
  procedures: ApproachRoute[];
  /** Main branches requiring an explicit association remain accounted for. */
  unavailable?: { id: string; airport: string; ident: string; reason: 'multiple-main-branches' | 'missing-main-branch'; branches: { id: string; legs: ApproachLeg[] }[] }[];
};

function coordinate(value: unknown): value is ApproachCoordinate {
  return Array.isArray(value) && value.length === 2 && value.every(Number.isFinite) &&
    Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;
}
export function isApproachLeg(value: unknown): value is ApproachLeg {
  return isRecord(value) && typeof value.path === 'string' && /^[A-Z]{2}$/.test(value.path) &&
    (value.id === undefined || text(value.id)) &&
    (value.sourceFix === undefined || isRecord(value.sourceFix) && text(value.sourceFix.id) && text(value.sourceFix.ident)) &&
    (value.rnpNm === undefined || typeof value.rnpNm === 'number' && Number.isFinite(value.rnpNm) && value.rnpNm >= 0) &&
    (value.speed === undefined || isRecord(value.speed) && typeof value.speed.knots === 'number' &&
      Number.isFinite(value.speed.knots) && value.speed.knots >= 0 && typeof value.speed.restriction === 'string' && value.speed.restriction.length <= 1) &&
    (value.verticalAngle === undefined || typeof value.verticalAngle === 'number' && Number.isFinite(value.verticalAngle) && Math.abs(value.verticalAngle) <= 90) &&
    (value.transitionAltitude === undefined || typeof value.transitionAltitude === 'string' && /^(?:\d{5}|-\d{4}|FL\d{3})$/.test(value.transitionAltitude)) &&
    (value.turnDirectionValid === undefined || typeof value.turnDirectionValid === 'boolean') &&
    (value.gnssFms === undefined || typeof value.gnssFms === 'string' && value.gnssFms.length === 1) &&
    (value.qualifiers === undefined || typeof value.qualifiers === 'string' && value.qualifiers.length === 2) &&
    (value.continuations === undefined || Array.isArray(value.continuations) && value.continuations.every(c =>
      isRecord(c) && typeof c.number === 'string' && /^[2-9A-Z]$/.test(c.number) &&
      typeof c.application === 'string' && c.application.length === 1 && typeof c.raw === 'string' && c.raw.length === 132 &&
      c.raw[38] === c.number && c.raw[39] === c.application &&
      (c.services === undefined || Array.isArray(c.services) && c.services.length === 3 && c.services.every(s =>
        isRecord(s) && typeof s.authorization === 'string' && s.authorization.length <= 1 && typeof s.name === 'string'))) &&
      hasUniqueStrings(value.continuations.map(c => c.number))) &&
    (value.reference === undefined || (isRecord(value.reference) && text(value.reference.id) && text(value.reference.ident) &&
      ['navaid', 'localizer'].includes(String(value.reference.type)) &&
      (value.reference.coordinate === undefined || coordinate(value.reference.coordinate)) &&
      (value.reference.dmeCoordinate === undefined || coordinate(value.reference.dmeCoordinate)) &&
      (value.reference.declination === undefined || typeof value.reference.declination === 'number' && Number.isFinite(value.reference.declination) && Math.abs(value.reference.declination) <= 180))) &&
    (value.radial === undefined || typeof value.radial === 'number' && Number.isFinite(value.radial) && value.radial >= 0 && value.radial < 360) &&
    (value.rhoNm === undefined || typeof value.rhoNm === 'number' && Number.isFinite(value.rhoNm) && value.rhoNm >= 0) &&
    (value.altitude === undefined || (isRecord(value.altitude) && typeof value.altitude.restriction === 'string' && value.altitude.restriction.length <= 1 &&
      typeof value.altitude.first === 'string' && /^(?:\d{5}|-\d{4}|FL\d{3}|)$/.test(value.altitude.first) &&
      typeof value.altitude.second === 'string' && /^(?:\d{5}|-\d{4}|FL\d{3}|)$/.test(value.altitude.second))) &&
    (value.waypointDescriptor === undefined || typeof value.waypointDescriptor === 'string' && value.waypointDescriptor.length === 4) &&
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
    (value.metadata.schemaVersion === undefined || value.metadata.schemaVersion === 2) &&
    (value.unavailable === undefined || Array.isArray(value.unavailable) && value.unavailable.every(p => isRecord(p) &&
      text(p.id) && text(p.airport) && text(p.ident) && ['multiple-main-branches', 'missing-main-branch'].includes(String(p.reason)) &&
      Array.isArray(p.branches) && p.branches.length > 0 && p.branches.every(b => isRecord(b) && text(b.id) && Array.isArray(b.legs) && b.legs.length > 0 && b.legs.every(isApproachLeg)))) &&
    text(value.metadata.source) && Array.isArray(value.procedures) && value.procedures.every(p =>
      isRecord(p) && text(p.id) && text(p.airport) && text(p.ident) &&
      (p.magneticVariation === undefined || typeof p.magneticVariation === 'number' && Number.isFinite(p.magneticVariation) && Math.abs(p.magneticVariation) <= 180) &&
      Array.isArray(p.final) && p.final.length > 0 && p.final.every(isApproachLeg) &&
      Array.isArray(p.transitions) && p.transitions.every(t => isRecord(t) && text(t.id) &&
        Array.isArray(t.legs) && t.legs.length > 0 && t.legs.every(isApproachLeg)) &&
      hasUniqueStrings(p.transitions.map(t => t.id))) && hasUniqueStrings(value.procedures.map(p => p.id));
}
