import { hasJsonReferenceIdentity, type JsonReferenceIdentity } from './json-reference.js';
import { isApproachRoutesData, type ApproachRoutesData } from './approach-routes.js';
import { hasUniqueStrings, isIsoDate, isNonEmptyString as text, isNonNegativeInteger as count,
  isPositiveInteger, isRecord } from './validation.js';

export type TerminalProceduresResource = JsonReferenceIdentity & {
  id: 'terminal-procedures';
  title: string;
  count: number;
  sourceCount: number;
  url: string;
};

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
  metadata: { effectiveDate: string; source: string };
  procedures: TerminalProcedure[];
  approaches?: ApproachRoutesData;
};

export function isTerminalProceduresResource(value: unknown): value is TerminalProceduresResource {
  return isRecord(value) && value.id === 'terminal-procedures' && text(value.title) && text(value.url) &&
    count(value.count) && count(value.sourceCount) && value.count <= value.sourceCount &&
    hasJsonReferenceIdentity(value);
}

export function isTerminalProceduresData(value: unknown, revision?: string): value is TerminalProceduresData {
  return isRecord(value) && value.type === 'ZLayerTerminalProcedures' && isRecord(value.metadata) &&
    isIsoDate(value.metadata.effectiveDate) && (revision === undefined || value.metadata.effectiveDate === revision) &&
    text(value.metadata.source) && Array.isArray(value.procedures) && value.procedures.every(isProcedure) &&
    hasUniqueStrings(value.procedures.map(procedure => procedure.id)) &&
    (value.approaches === undefined || isApproachRoutesData(value.approaches, value.metadata.effectiveDate));
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
