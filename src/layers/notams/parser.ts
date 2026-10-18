import type { NotamRecord } from '@zlayer/contracts';
import { qualifiedFdcLocalText } from './source-text';
import { subjects, approachFacilityComponents, type ParsedNotam, type NotamInterpretationIssue } from './interpretation';
import { procedureTargets } from './procedure-targets';
import { notamEffects } from './effects';
import { obstacleBodyFields } from './obstacle-fields';
import { navigationNotice } from './navigation-notice';
import { noticeSubject } from './notice-subject';
import { notamParts, maskNotamParts } from './multipart';
export type { ParsedNotam, NotamTarget, NotamFact, NotamFlair, NotamFlairTone, NotamEvidence } from './interpretation';
export { normalizeRunway } from './interpretation';

export const NOTAM_PARSER_VERSION = 17;
const parsedRecords = new WeakMap<NotamRecord, ParsedNotam>();
const MAX_PARSE_LENGTH = 64 * 1024;
/** Only local-format identity headers; pointers and unfamiliar envelopes remain content. */
export function localNotamContent(body: string, record?: Pick<NotamRecord, 'locations' | 'icaoLocations'>): string {
  let content = body.replace(/^\s*!(?:FDC\s+\d+\/\d+\s+[A-Z0-9]+|[A-Z0-9]+\s+\d+\/\d+\s+[A-Z0-9]+)\s+/i, '');
  const placeholder = /^\s*!UNDEFINED XX\/XXX ([A-Z0-9]{3,5})\s+/i.exec(content);
  if (placeholder && record?.locations.includes(placeholder[1]!)) content = content.slice(placeholder[0].length);
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
  const local = localNotamContent(body, record);
  // This establishes only the first-part subject/title. Presentation keeps all
  // markers and no numeric interpretation crosses an unassembled part boundary.
  const firstPart = /^\s*PART 1 OF (?:[2-9]|[1-9]\d)\s+(?=IAP\b|ODP\b|SID\b|STAR\b)/i.exec(local);
  const header = body.length - local.length + (firstPart?.[0].length ?? 0);
  const parts = firstPart ? notamParts(body) : undefined;
  const assembled = !!parts?.some(part => part.closing);
  const content = (assembled ? maskNotamParts(body, parts!) : body).slice(header, header + MAX_PARSE_LENGTH), subjectMatch = /^\s*([A-Z]+)\b/i.exec(content);
  const subjectKeyword = subjectMatch?.[1]?.toUpperCase();
  // An omitted OBST keyword requires the complete ordered obstacle field form;
  // a free-standing TOWER, quoted position or incidental crane mention is not enough.
  const navigation = navigationNotice(content, record, body, header);
  const known = subjectKeyword && subjects[subjectKeyword] ? subjectKeyword : undefined;
  const obstacle = !known && !navigation ? obstacleBodyFields(content) : undefined;
  const recovered = !known && !navigation && !obstacle ? noticeSubject(record, content) : undefined;
  const subject = known ?? (navigation ? 'NAV' : obstacle ? 'OBST' : recovered?.subject);
  const procedureNotice = ['IAP', 'SID', 'STAR', 'ODP', 'DVA'].includes(subject ?? '');
  const broad = subject === 'IAP' && /^\s*ALL\s+(?:IAPS|INSTRUMENT\s+APPROACH\s+PROCEDURES)\b/i.test(content.slice(subjectMatch?.[0].length ?? 0));
  const broadRestricted = broad && /\b(?:EXC|EXCEPT|EXCLUDING|OTHER\s+THAN|ONLY|IF|WHEN|UNLESS|PROVIDED)\b/i.test(content);
  const { targets, limited } = procedureNotice ? procedureTargets(content, subject, body, header) : { targets: [], limited: false };
  const { facts, factLimit, facilityTarget, categoryTarget, runwayTargets } = notamEffects(content, body, header, subject, targets, !!firstPart && !assembled, navigation);
  const issues: NotamInterpretationIssue[] = [];
  if (!subject) issues.push('subject');
  if (procedureNotice && !targets.length && !broad) issues.push('procedure-target');
  if (broadRestricted) issues.push('procedure-exceptions');
  if (subject === 'NAV' && !categoryTarget && (!facilityTarget || !approachFacilityComponents(facilityTarget.facility).length)) issues.push('facility-dependency');
  if (firstPart && !assembled) issues.push('multipart');
  if (limited) issues.push('headings');
  if (factLimit) issues.push('fact-limit');
  if (body.length - header > MAX_PARSE_LENGTH) issues.push('body-limit');
  const result = { body, subject, facts, targets, broad, broadRestricted, procedureNotice,
    runwayTargets,
    ...(facilityTarget ? { facilityTarget } : {}),
    ...(categoryTarget ? { categoryTarget } : {}),
    ...(navigation ? { navigation } : {}),
    ...(recovered ? { subjectBasis: recovered.basis } : {}),
    issues, unresolved: issues.length > 0 };
  parsedRecords.set(record, result);
  return result;
}
