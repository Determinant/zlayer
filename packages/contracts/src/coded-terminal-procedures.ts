import { isApproachLeg, type ApproachLeg } from './approach-routes.js';
import { hasUniqueStrings, isIsoDate, isNonEmptyString as text, isRecord } from './validation.js';

export type CodedTerminalBranch = { id: string; routeType: string; transition: string; legs: ApproachLeg[] };
export type CodedTerminalProcedure = {
  id: string; airport: string; ident: string; kind: 'departure' | 'arrival';
  magneticVariation?: number;
  runways?: { ident: string; coordinate: [number, number] }[];
  branches: CodedTerminalBranch[];
};
export type CodedTerminalProceduresData = {
  type: 'ZLayerCodedTerminalProcedures';
  metadata: { effectiveDate: string; source: string; schemaVersion: 1 };
  procedures: CodedTerminalProcedure[];
};

export function isCodedTerminalProceduresData(value: unknown, revision?: string): value is CodedTerminalProceduresData {
  return isRecord(value) && value.type === 'ZLayerCodedTerminalProcedures' && isRecord(value.metadata) &&
    value.metadata.schemaVersion === 1 && isIsoDate(value.metadata.effectiveDate) && text(value.metadata.source) &&
    (revision === undefined || revision === value.metadata.effectiveDate) && Array.isArray(value.procedures) &&
    value.procedures.every(p => isRecord(p) && text(p.id) && text(p.airport) && text(p.ident) &&
      ['departure', 'arrival'].includes(String(p.kind)) &&
      (p.magneticVariation === undefined || typeof p.magneticVariation === 'number' && Number.isFinite(p.magneticVariation) && Math.abs(p.magneticVariation) <= 180) &&
      (p.runways === undefined || Array.isArray(p.runways) && p.runways.every(r => isRecord(r) && text(r.ident) &&
        Array.isArray(r.coordinate) && r.coordinate.length === 2 && r.coordinate.every(Number.isFinite) &&
        Math.abs(r.coordinate[0]) <= 180 && Math.abs(r.coordinate[1]) <= 90) && hasUniqueStrings(p.runways.map(r => r.ident))) &&
      Array.isArray(p.branches) && p.branches.length > 0 && p.branches.every(b => isRecord(b) && text(b.id) &&
        typeof b.routeType === 'string' && /^[0-9A-Z]$/.test(b.routeType) && typeof b.transition === 'string' &&
        b.id === `${b.routeType}:${b.transition}` && Array.isArray(b.legs) && b.legs.length > 0 &&
        b.legs.every(isApproachLeg) && b.legs.every(l => text(l.id)) && hasUniqueStrings(b.legs.map(l => l.id!))) &&
      hasUniqueStrings(p.branches.map(b => b.id))) && hasUniqueStrings(value.procedures.map(p => p.id));
}
