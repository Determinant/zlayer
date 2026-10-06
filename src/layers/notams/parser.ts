import type { NotamRecord } from '@zlayer/contracts';
import { qualifiedFdcLocalText } from './source-text';
import { subjects, approachFacilities, type ParsedNotam, type NotamInterpretationIssue } from './interpretation';
import { procedureTargets } from './procedure-targets';
import { notamEffects } from './effects';
export type { ParsedNotam, NotamTarget, NotamFact, NotamFlair, NotamFlairTone, NotamEvidence } from './interpretation';
export { normalizeRunway } from './interpretation';

export const NOTAM_PARSER_VERSION = 9;
const parsedRecords = new WeakMap<NotamRecord, ParsedNotam>();
const MAX_PARSE_LENGTH = 64 * 1024;
/** Only local-format identity headers; pointers and unfamiliar envelopes remain content. */
export function localNotamContent(body: string, record?: Pick<NotamRecord, 'locations' | 'icaoLocations'>): string {
  const content = body.replace(/^\s*!(?:FDC\s+\d+\/\d+\s+[A-Z0-9]+|[A-Z0-9]+\s+\d+\/\d+\s+[A-Z0-9]+)\s+/i, '');
  const prefix = /^([A-Z0-9]+)\s+([A-Z]+)\b/.exec(content);
  return prefix && subjects[prefix[2]!] && record && [...record.locations, ...record.icaoLocations].includes(prefix[1]!)
    ? content.slice(prefix[0].lastIndexOf(prefix[2]!)) : content;
}

/** Derive only supported clauses; retain the full body for presentation and source evidence. */
export function parseNotam(record: NotamRecord): ParsedNotam {
  const cached = parsedRecords.get(record); if (cached) return cached;
  let body = record.text || record.translations.find(t => t.type === 'LOCAL_FORMAT')?.text || record.translations[0]?.text || '';
  const keyword = /^\s*([A-Z]+)\b/i.exec(localNotamContent(body, record))?.[1]?.toUpperCase();
  if (!keyword || !subjects[keyword]) body = qualifiedFdcLocalText(record) ?? body;
  // Local-format headers identify the notice; a SEE FDC pointer never changes its class.
  const header = body.length - localNotamContent(body, record).length;
  const content = body.slice(header, header + MAX_PARSE_LENGTH), subjectMatch = /^\s*([A-Z]+)\b/i.exec(content);
  const subjectKeyword = subjectMatch?.[1]?.toUpperCase(), subject = subjectKeyword && subjects[subjectKeyword] ? subjectKeyword : undefined;
  const procedureNotice = ['IAP', 'SID', 'STAR', 'ODP'].includes(subject ?? '');
  const broad = subject === 'IAP' && /^\s*ALL\s+(?:IAPS|INSTRUMENT\s+APPROACH\s+PROCEDURES)\b/i.test(content.slice(subjectMatch?.[0].length ?? 0));
  const broadRestricted = broad && /\b(?:EXC|EXCEPT|EXCLUDING|OTHER\s+THAN|ONLY|IF|WHEN|UNLESS|PROVIDED)\b/i.test(content);
  const { targets, limited } = procedureNotice ? procedureTargets(content, subject, body, header) : { targets: [], limited: false };
  const { facts, factLimit, facilityTarget, runwayTargets } = notamEffects(content, body, header, subject, targets);
  const issues: NotamInterpretationIssue[] = [];
  if (!subject) issues.push('subject');
  if (procedureNotice && !targets.length && !broad) issues.push('procedure-target');
  if (broadRestricted) issues.push('procedure-exceptions');
  if (subject === 'NAV' && (!facilityTarget || !approachFacilities.has(facilityTarget.facility))) issues.push('facility-dependency');
  if (limited) issues.push('headings');
  if (factLimit) issues.push('fact-limit');
  if (body.length - header > MAX_PARSE_LENGTH) issues.push('body-limit');
  const result = { body, subject, facts, targets, broad, broadRestricted, procedureNotice,
    runwayTargets,
    ...(facilityTarget ? { facilityTarget } : {}),
    issues, unresolved: issues.length > 0 };
  parsedRecords.set(record, result);
  return result;
}
