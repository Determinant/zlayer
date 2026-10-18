import type { NotamRecord } from '@zlayer/contracts';
import { icaoEvidence } from './notice-evidence';

export type NotamSubjectBasis = { kind: 'icao-code'; code: string } | { kind: 'wording'; text: string };
// FAA JO 7930.2, Appendix B. Only the subject pair is decoded here; a Q-line
// status never establishes an unqualified body effect or repairs a coordinate.
const subjectCodes: Record<string, string> = {
  FA: 'AD', FF: 'SVC', MN: 'APRON', MX: 'TWY', MR: 'RWY', OB: 'OBST', OL: 'OBST',
  PA: 'STAR', PD: 'SID', PI: 'IAP', PM: 'IAP', WU: 'AIRSPACE', WD: 'AIRSPACE',
  NA: 'NAV', NB: 'NAV', ND: 'NAV', NF: 'NAV', NL: 'NAV', NM: 'NAV', NN: 'NAV', NT: 'NAV', NV: 'NAV',
  IC: 'NAV', ID: 'NAV', IG: 'NAV', II: 'NAV', IL: 'NAV', IM: 'NAV', IO: 'NAV', IT: 'NAV', IU: 'NAV', IX: 'NAV',
};

/** Subject recovery keeps the original body. Coded evidence must account for
 * every rendering's whole body, identity, location, interval and schedule.
 * QXXXX is not a subject. Without a bound code, only explicit leading wording
 * or a complete primary ramp envelope can establish one. */
export function noticeSubject(record: NotamRecord, content: string): { subject: string; basis: NotamSubjectBasis } | undefined {
  const proof = icaoEvidence(record);
  if (proof?.recordBound) {
    const codes = proof.notices.map(notice => notice.q[1]);
    const code = codes[0], subject = code && subjectCodes[code.slice(1, 3)];
    if (subject && codes.every(value => value === code)) return { subject, basis: { kind: 'icao-code', code: code! } };
  }
  const words = content.trim().toUpperCase().split(/\s+/).map(word => word.replace(/[.,]$/, ''));
  const explicit: [RegExp, string][] = [
    [/^AERODROME\b/, 'AD'], [/^NAVAID\b/, 'NAV'], [/^RWY(?=\d{1,2}[LRC]?\b)/, 'RWY'],
    [/^OBSTACLE LIGHTS?\b/, 'OBST'], [/^(?:REDUCED )?ARFF\b/, 'SVC'],
    [/^APCH CONTROL\b/, 'COM'], [/^MILITARY ADACG OPERATING HOURS\b/, 'SVC'],
    [/^SITE [A-Z0-9 -]{1,40}: AIRSPACE\b/, 'AIRSPACE'],
    [/^UNMANNED ACFT WITHIN AREA DEFINED AS\b/, 'AIRSPACE'],
    [/^\[US DOD DAFIF ONLY\] STANDARD TERMINAL ARRIVAL ROUTE;/, 'STAR'],
    [/^(?:LARGE CO(?:N)?CENTRATION OF LO ALT MIL ACFT OPS|CAUTION; HI VOLUME OF MIL ACFT)\b/, 'AIRSPACE'],
    [/^WIP ADJ TWY\b/, 'TWY'],
    [/^SPOT [A-Z0-9-]+ (?:CLSD|CLOSED)\b/, 'APRON'],
    [/^MEN AND EQUIPMENT ON [A-Z ]{1,50} RAMP FOR\b/, 'APRON'],
    [/^PERSONNEL AND EQUIPMENT AND OPEN TRENCH LOCATED\b/, 'OBST'],
    [/^[A-Z .'-]{1,60} (?:AIR|SPACE) FORCE BASE, NO LOX SERVICING\b/, 'SVC'],
    [/^MIL TXL\b/, 'TWY'],
    [/^[A-Z .'-]{1,60} (?:AIR|SPACE) FORCE BASE: MIL TAXIWAY\b/, 'TWY'],
  ];
  for (const [pattern, subject] of explicit) {
    const match = pattern.exec(content.trim().toUpperCase());
    if (match) return { subject, basis: { kind: 'wording', text: match[0] } };
  }
  const ramp = words.indexOf('RAMP'), prefix = words.slice(0, ramp);
  if (ramp >= 1 && ramp <= 16 && prefix.some(word => ['FORCE', 'GUARD', 'MIL', 'RED', 'SOUTH', 'TRANSIENT', 'IMA', 'ALL'].includes(word)) &&
    prefix.every(word => /^[A-Z0-9.'-]+$/.test(word) &&
      !['NOTE', 'NOT', 'IF', 'WHEN', 'UNLESS', 'EXCEPT', 'SEE', 'DELETE', 'CHANGE', 'ADD', 'ON', 'NEAR', 'TO'].includes(word))) {
    return { subject: 'APRON', basis: { kind: 'wording', text: words.slice(0, ramp + 1).join(' ') } };
  }
  if (/^ALL ALL ADC RAMP - OBSTRUCTION LIGHT OUTAGE\b/.test(content.toUpperCase())) {
    return { subject: 'OBST', basis: { kind: 'wording', text: 'ALL ALL ADC RAMP - OBSTRUCTION LIGHT OUTAGE' } };
  }
  return;
}
