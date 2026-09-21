import { hasJsonReferenceIdentity, type JsonReferenceIdentity } from './json-reference.js';
import { isApproachRoutesData, type ApproachRoutesData } from './approach-routes.js';
import { isCodedTerminalProceduresData, type CodedTerminalProceduresData } from './coded-terminal-procedures.js';
import { hasUniqueStrings, isIsoDate, isNonEmptyString as text, isNonNegativeInteger as count,
  isPositiveInteger, isRecord } from './validation.js';

export type TerminalProceduresResource = JsonReferenceIdentity & {
  id: 'terminal-procedures';
  title: string;
  count: number;
  sourceCount: number;
  url: string;
  /** Present on complete exports. Legacy filing-only resources have no version. */
  schemaVersion?: 2;
  coverage?: TerminalCoverage;
};

export type TerminalCoverage = {
  departures: number; arrivals: number; approaches: number; unavailableApproaches: number;
  codedDepartures: number; codedArrivals: number;
  sourceLegs: { departure: number; arrival: number; approach: number };
  exportedLegs: { departure: number; arrival: number; approach: number };
  continuationRecords: number; exportedContinuations: number; unresolvedReferences: number;
};

export function isTerminalCoverage(value: unknown): value is TerminalCoverage {
  if (!isRecord(value) || !isRecord(value.sourceLegs) || !isRecord(value.exportedLegs)) return false;
  const { sourceLegs, exportedLegs } = value;
  return ['departures', 'arrivals', 'approaches', 'unavailableApproaches', 'codedDepartures',
    'codedArrivals', 'continuationRecords', 'exportedContinuations', 'unresolvedReferences'].every(key => count(value[key])) &&
    ['departure', 'arrival', 'approach'].every(kind => count(sourceLegs[kind]) && sourceLegs[kind] === exportedLegs[kind]) &&
    value.continuationRecords === value.exportedContinuations;
}

export type TerminalProcedurePoint = {
  sequence: number;
  ident: string;
  type: string;
  icaoRegion?: string;
  next?: string;
};

export type TerminalProcedureRoute = {
  name: string;
  kind: 'body' | 'transition';
  bodySequence: number;
  transition?: string;
  airports: { ident: string; runway?: string }[];
  points: TerminalProcedurePoint[];
};

export type TerminalProcedure = {
  id: string;
  ident: string;
  kind: 'departure' | 'arrival';
  name: string;
  computerCode: string;
  airports: string[];
  routes: TerminalProcedureRoute[];
};

/** Waypoint-route topology, not ARINC flight-guidance legs. */
export type TerminalProceduresData = {
  type: 'ZLayerTerminalProcedures';
  metadata: { effectiveDate: string; source: string; schemaVersion?: 2 };
  procedures: TerminalProcedure[];
  approaches?: ApproachRoutesData;
  codedProcedures?: CodedTerminalProceduresData;
  coverage?: TerminalCoverage;
};

export function isTerminalProceduresResource(value: unknown): value is TerminalProceduresResource {
  return isRecord(value) && value.id === 'terminal-procedures' && text(value.title) && text(value.url) &&
    count(value.count) && count(value.sourceCount) && value.count <= value.sourceCount &&
    hasJsonReferenceIdentity(value) && (value.schemaVersion === undefined
      ? value.coverage === undefined
      : value.schemaVersion === 2 && typeof value.jsonSha256 === 'string' && isTerminalCoverage(value.coverage));
}

export function isTerminalProceduresData(value: unknown, revision?: string): value is TerminalProceduresData {
  return isRecord(value) && value.type === 'ZLayerTerminalProcedures' && isRecord(value.metadata) &&
    isIsoDate(value.metadata.effectiveDate) && (revision === undefined || value.metadata.effectiveDate === revision) &&
    text(value.metadata.source) && Array.isArray(value.procedures) && value.procedures.every(isProcedure) &&
    hasUniqueStrings(value.procedures.map(procedure => procedure.id)) &&
    (value.codedProcedures === undefined || isCodedTerminalProceduresData(value.codedProcedures, value.metadata.effectiveDate)) &&
    (value.approaches === undefined || isApproachRoutesData(value.approaches, value.metadata.effectiveDate)) &&
    (value.metadata.schemaVersion === undefined ? value.coverage === undefined
      : value.metadata.schemaVersion === 2 && completeCoverage(value as TerminalProceduresData));
}

function completeCoverage(value: TerminalProceduresData): boolean {
  const { coverage: c, approaches, codedProcedures } = value;
  if (!isTerminalCoverage(c) || !approaches || !codedProcedures) return false;
  if (value.procedures.filter(p => p.kind === 'departure').length !== c.departures ||
      value.procedures.filter(p => p.kind === 'arrival').length !== c.arrivals ||
      codedProcedures.procedures.filter(p => p.kind === 'departure').length !== c.codedDepartures ||
      codedProcedures.procedures.filter(p => p.kind === 'arrival').length !== c.codedArrivals ||
      approaches.procedures.length !== c.approaches || (approaches.unavailable?.length ?? 0) !== c.unavailableApproaches) return false;
  const counts = { departure: 0, arrival: 0, approach: 0 };
  let continuations = 0;
  const add = (kind: keyof typeof counts, legs: import('./approach-routes.js').ApproachLeg[]) => {
    counts[kind] += legs.length;
    for (const leg of legs) continuations += leg.continuations?.length ?? 0;
  };
  for (const p of codedProcedures.procedures) for (const b of p.branches) add(p.kind, b.legs);
  for (const p of approaches.procedures) {
    add('approach', p.final);
    for (const b of p.transitions) add('approach', b.legs);
  }
  for (const p of approaches.unavailable ?? []) for (const b of p.branches) add('approach', b.legs);
  return (Object.keys(counts) as (keyof typeof counts)[]).every(kind => counts[kind] === c.exportedLegs[kind]) &&
    continuations === c.exportedContinuations;
}

function airportIdent(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z0-9]+$/.test(value);
}

function isProcedure(value: unknown): value is TerminalProcedure {
  if (!isRecord(value) || !text(value.id) || !text(value.ident) || !text(value.name) ||
      !text(value.computerCode) || !['departure', 'arrival'].includes(String(value.kind)) ||
      !Array.isArray(value.airports) || !value.airports.length || !value.airports.every(airportIdent) ||
      !Array.isArray(value.routes) || !value.routes.every(isRoute)) return false;
  const parts = value.computerCode.split('.');
  return parts.length === 2 && parts.every(text) && value.ident === parts[value.kind === 'departure' ? 0 : 1];
}

function isRoute(value: unknown): value is TerminalProcedureRoute {
  if (!isRecord(value) || !text(value.name) || !['body', 'transition'].includes(String(value.kind)) ||
      !isPositiveInteger(value.bodySequence) || (value.transition !== undefined && !text(value.transition)) ||
      !Array.isArray(value.airports) || !value.airports.every(airport => isRecord(airport) && airportIdent(airport.ident) &&
        (airport.runway === undefined || text(airport.runway))) ||
      !Array.isArray(value.points) || !value.points.length) return false;
  let previous = 0;
  for (const point of value.points) {
    if (!isRecord(point) || !isPositiveInteger(point.sequence) || point.sequence <= previous ||
        !text(point.ident) || !text(point.type) || (point.next !== undefined && !text(point.next)) ||
        (point.icaoRegion !== undefined && !text(point.icaoRegion))) return false;
    previous = point.sequence;
  }
  return true;
}
