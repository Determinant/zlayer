import { isRecord, isIsoDate, isSha256, isNonEmptyString as text, hasUniqueStrings } from './validation.js';

export type ApproachAssociations = {
  schemaVersion: 1; ruleVersion: 1; effectiveDate: string;
  sources: { terminalJsonSha256: string; cifpSha256: string; chartXmlSha256: string; reviewsSha256?: string };
  records: { airport: string; procedureId: string; title: string; routeIds: string[];
    status: 'matched' | 'ambiguous' | 'unmatched'; rule: 'canonical' | 'reviewed' | 'parallel-equivalent' | 'parallel-choice' | 'unmatched';
    evidence?: { plateUrl: string; comparedFixes: string } }[];
};
export function isApproachAssociations(value: unknown): value is ApproachAssociations {
  if (!isRecord(value) || !isRecord(value.sources)) return false;
  const sources = value.sources;
  return value.schemaVersion === 1 && value.ruleVersion === 1 && isIsoDate(value.effectiveDate) &&
    ['terminalJsonSha256', 'cifpSha256', 'chartXmlSha256'].every(key => isSha256(sources[key])) &&
    (sources.reviewsSha256 === undefined || isSha256(sources.reviewsSha256)) &&
    Array.isArray(value.records) && value.records.every(r => isRecord(r) && text(r.airport) && text(r.procedureId) && text(r.title) &&
      Array.isArray(r.routeIds) && r.routeIds.every(text) && hasUniqueStrings(r.routeIds) &&
      r.status === (r.routeIds.length === 0 ? 'unmatched' : r.routeIds.length === 1 ? 'matched' : 'ambiguous') &&
      ['canonical', 'reviewed', 'parallel-equivalent', 'parallel-choice', 'unmatched'].includes(String(r.rule)) &&
      (r.rule !== 'unmatched' || r.status === 'unmatched') &&
      (r.rule !== 'reviewed' || isRecord(r.evidence) && text(r.evidence.plateUrl) && text(r.evidence.comparedFixes))) &&
    hasUniqueStrings(value.records.map(r => r.procedureId));
}
