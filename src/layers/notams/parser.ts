import type { NotamRecord } from '@zlayer/contracts';
import { qualifiedFdcLocalText } from './source-text';

export const NOTAM_PARSER_VERSION = 7;
const subjects: Record<string, string> = { RWY: 'Runway', TWY: 'Taxiway', APRON: 'Apron', AD: 'Aerodrome',
  OBST: 'Obstruction', NAV: 'Navigation', COM: 'Communications', SVC: 'Services', AIRSPACE: 'Airspace',
  ODP: 'Departure', SID: 'Departure', STAR: 'Arrival', CHART: 'Chart', DATA: 'Data', DVA: 'Vector Area',
  IAP: 'Approach', VFP: 'Visual Procedure', ROUTE: 'Route', SPECIAL: 'Special', SECURITY: 'Security' };
export type NotamEvidence = { start: number; end: number; text: string };
export type NotamFlairTone = 'info' | 'procedure' | 'caution' | 'danger' | 'neutral';
export type NotamFlair = { label: string; tone: NotamFlairTone; evidence: NotamEvidence };
export type NotamTarget = { title: string; amendment?: string; evidence: NotamEvidence };
export type ParsedNotam = { body: string; subject: string | undefined; flairs: NotamFlair[];
  targets: NotamTarget[]; broad: boolean; broadRestricted: boolean; runwayTargets: string[];
  facilityTarget?: { facility: string; runway: string }; procedureNotice: boolean; unresolved: boolean };
const evidence = (body: string, start: number, length: number): NotamEvidence => ({ start, end: start + length, text: body.slice(start, start + length) });
const parsedRecords = new WeakMap<NotamRecord, ParsedNotam>();
const MAX_PARSE_LENGTH = 64 * 1024, MAX_HEADING_LENGTH = 320, MAX_TARGETS = 16, MAX_FLAIRS = 20;
/** Only local-format identity headers; pointers and unfamiliar envelopes remain content. */
export function localNotamContent(body: string, record?: Pick<NotamRecord, 'locations' | 'icaoLocations'>): string {
  const content = body.replace(/^\s*!(?:FDC\s+\d+\/\d+\s+[A-Z0-9]+|[A-Z0-9]+\s+\d+\/\d+\s+[A-Z0-9]+)\s+/i, '');
  const prefix = /^([A-Z0-9]+)\s+([A-Z]+)\b/.exec(content);
  return prefix && subjects[prefix[2]!] && record && [...record.locations, ...record.icaoLocations].includes(prefix[1]!)
    ? content.slice(prefix[0].lastIndexOf(prefix[2]!)) : content;
}
const approachTitle = /(?:HI\s*-\s*)?(?:COPTER\s+)?(?:ILS(?:\s+[XYZ])?\s+OR\s+LOC(?:\/DME)?|ILS(?:\/DME)?|LOC(?:\/DME)?(?:\s+BC)?|RNAV\s*\((?:GPS|RNP)\)|RNAV|VOR(?:\/DME)?(?:\s+OR\s+TACAN)?|TACAN|NDB(?:\/DME)?|LDA(?:\/DME)?|SDF|GLS)(?:\s+[XYZ])?(?:\s+RWY\s+\d{1,2}[LRC]?|-[A-Z])\s*$/i;
const incidentalHeading = /\b(?:MISSED|EXC|EXCEPT|OBST|CRANE|NOTE|TRANSITION|CIRCLING|SEE|SPECIAL)\b/i;
const headingPrefix = (prefix: string) => !incidentalHeading.test(prefix) && (!prefix.trim() || /[.,]\s*$/.test(prefix));
// A later quoted or conditional procedure name is not another affected heading.
const headingNarrative = /\b(?:MISSED|EXC|EXCEPT|EXCLUDING|OBST|CRANE|NOTES?|TRANSITIONS?|CIRCLING|SEE|DISREGARD|DELETE|ADD|CHANGE|IF|WHEN|UNLESS|PROVIDED)\b/i;
const amendmentSuffix = /,\s*(?:AMDT\s+([A-Z0-9-]+)|ORIG(?:INAL)?(?:-([A-Z0-9]+))?)\s*$/i;

function procedureTargets(content: string, subject: string | undefined, body: string, header: number) {
  const targets: NotamTarget[] = []; let limited = false;
  const namedHeadingStop = Math.min(incidentalHeading.exec(content)?.index ?? content.length,
    /\b(?:DISREGARD|DELETE|ADD|CHANGE|IF|WHEN|UNLESS)\b/i.exec(content)?.index ?? content.length);
  const add = (title: string, start: number, amendment?: string) => {
    if (targets.some(t => t.title === title && t.amendment === amendment)) return;
    if (targets.length >= MAX_TARGETS) { limited = true; return; }
    targets.push({ title, ...(amendment ? { amendment } : {}), evidence: evidence(body, header + start, title.length) });
  };
  if (subject === 'IAP') {
    // Parse each heading independently, with or without an amendment. One valid
    // heading does not establish coverage of the rest of a multi-procedure notice.
    const stop = headingNarrative.exec(content)?.index ?? content.length;
    for (const clause of content.slice(0, stop).matchAll(/[^.\n;]+/g)) {
      const source = clause[0], offset = clause.index;
      if (source.length > MAX_HEADING_LENGTH) { limited = true; continue; }
      const amendment = amendmentSuffix.exec(source);
      const heading = (amendment ? source.slice(0, amendment.index) : source).replace(/^\s*IAP\s+/, '');
      const match = approachTitle.exec(heading);
      if (match && !heading.slice(0, match.index).trim()) {
        const title = match[0].trim();
        add(title, offset + source.indexOf(title), amendment ? amendment[1] ?? (amendment[2] ? `ORIG-${amendment[2]}` : 'ORIG') : undefined);
      } else if (match || amendment || /\bRWY\s+\d{1,2}[LRC]?\s*$/i.test(heading)) {
        // Preserve unsupported prefixes and compound headings as uncertainty;
        // never rescue a familiar suffix and claim the whole target was parsed.
        limited = true;
      }
    }
    return { targets, limited };
  }
  // Scan delimiters once, then apply title grammar only to a bounded prefix.
  // An unanchored "anything before AMDT" expression retries every suffix of a long line.
  for (const line of content.matchAll(/[^\n;]+/g)) {
    const text = line[0], offset = line.index!;
    if (subject === 'SID' || subject === 'STAR') {
      // Publisher line wrapping is not a heading boundary. Flat local renderings
      // can put the airport and several complete procedure headings on one line.
      for (const clause of text.matchAll(/[^.]+/g)) {
        if (offset + clause.index + clause[0].length > namedHeadingStop || clause[0].length > MAX_HEADING_LENGTH ||
          !text.startsWith('..', clause.index + clause[0].length)) continue;
        const named = /^\s*([A-Z][A-Z0-9 '-]{1,100}?)\s+(DEPARTURE|ARRIVAL)(?:\s*,\s*AMDT\s+([A-Z0-9-]+))?\s*$/i.exec(clause[0]);
        if (named && (subject === 'SID') === (named[2]!.toUpperCase() === 'DEPARTURE')) {
          const title = named[1]!.trim(); add(title, offset + clause.index + named[0].indexOf(title), named[3]);
        }
      }
    }
    let start = 0;
    for (const marker of text.matchAll(/,\s*(?:AMDT\s+([A-Z0-9-]+)|ORIG(?:INAL)?(?:-([A-Z0-9]+))?)\b/gi)) {
      const prefix = text.slice(start, marker.index), prefixStart = start;
      start = marker.index! + marker[0].length;
      if (prefix.length > MAX_HEADING_LENGTH) { limited = true; continue; }
      const match = approachTitle.exec(prefix);
      const approach = match && headingPrefix(prefix.slice(0, match.index)) ? match : null;
      const named = subject !== 'IAP' ? /(?:^|,)\s*([A-Z][A-Z0-9 .'-]{1,100}?(?:\s*\((?:RNAV|[A-Z0-9.]+)\))?)\s*$/i.exec(prefix) : null;
      const title = approach?.[0].trim() ?? named?.[1]?.trim();
      if (!title || incidentalHeading.test(prefix.slice(0, prefix.lastIndexOf(title)))) continue;
      add(title, offset + prefixStart + prefix.lastIndexOf(title), marker[1] ?? (marker[2] ? `ORIG-${marker[2]}` : 'ORIG'));
    }
  }
  return { targets, limited };
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
  const flairs: NotamFlair[] = [];
  let flairLimit = false;
  function addFlair(label: string, tone: NotamFlairTone, source: NotamEvidence) {
    if (flairs.some(f => f.label === label)) return;
    if (flairs.length >= MAX_FLAIRS) { flairLimit = true; return; }
    flairs.push({ label, tone, evidence: source });
  }
  function flair(label: string, match: RegExpExecArray | null, tone: NotamFlairTone = 'caution') {
    if (match) addFlair(label, tone, evidence(body, header + match.index, match[0].length));
  }
  function closure(label: string, match: RegExpExecArray | null) {
    if (!match) return;
    const tail = content.slice(match.index + match[0].length);
    const qualified = /^\s+(?:TO|EXC|EXCEPT|ONLY|WHEN|UNLESS)\b/i.test(tail);
    addFlair(qualified ? label.replace('Closed', 'Closure Restriction') : label, qualified ? 'caution' : 'danger',
      evidence(body, header + match.index, match[0].length + (qualified ? tail.length : 0)));
  }
  if (subject) flair(subjects[subject]!, subjectMatch!, procedureNotice ? 'procedure' : 'info');
  for (const target of targets) addFlair(target.title, 'procedure', target.evidence);
  const runway = subject === 'RWY' ? /^\s*RWY\s+(\d{1,2}[LRC]?(?:\/\d{1,2}[LRC]?)?)(?=\s)/i.exec(content) : null;
  if (runway) flair(`RWY ${runway[1]!.toUpperCase()}`, runway, 'info');
  if (subject === 'RWY') {
    closure('Runway Closed', /^\s*RWY\s+\d{1,2}[LRC]?(?:\/\d{1,2}[LRC]?)?\s+CLSD\b/i.exec(content));
    const lights = /^\s*RWY\s+\d{1,2}[LRC]?(?:\/\d{1,2}[LRC]?)?\s+(RWY\s+END\s+ID\s+LGT|(?:EDGE\s+)?LGT|RAI\s+LGT|ALS|MALSR|MALSF|ALSF-[12]|ODALS|HIRL|MIRL|REIL|PAPI|VASI)\s+U\/S\b/i.exec(content);
    if (lights) {
      const name = lights[1]!.toUpperCase().replace(/\s+/g, ' ');
      const label = name === 'ALS' ? 'Approach Lights Unavailable' : name === 'RAI LGT' ? 'RAI Lights Unavailable'
        : ['PAPI', 'VASI', 'MALSR', 'MALSF', 'ALSF-1', 'ALSF-2', 'ODALS'].includes(name) ? `${name} Unavailable` : 'Lighting Unavailable';
      flair(label, lights);
    }
  }
  if (subject === 'TWY') {
    const taxiway = /^\s*TWY\s+([A-Z0-9]+(?:\/[A-Z0-9]+)*)\b/i.exec(content);
    if (taxiway) flair(`TWY ${taxiway[1]!.toUpperCase()}`, taxiway, 'info');
    closure('Taxiway Closed', /^\s*TWY\s+[A-Z0-9/]+(?:\s+BTN\s+TWY\s+[A-Z0-9]+\s+AND\s+TWY\s+[A-Z0-9]+)?\s+CLSD\b/i.exec(content));
  }
  if (subject === 'APRON') {
    closure('Taxilane Closed', /^\s*APRON\s+(?:[A-Z0-9]+\s+){0,4}TXL\s+BTN\s+TWY\s+[A-Z0-9]+\s+AND\s+TWY\s+[A-Z0-9]+\s+CLSD\b/i.exec(content));
    closure('Apron Closed', /^\s*APRON\s+(?:[A-Z0-9]+\s+){0,3}CLSD\b/i.exec(content));
  }
  if (subject === 'AD') closure('Airport Closed', /^\s*AD\s+AP\s+CLSD\b/i.exec(content));
  let facilityTarget: ParsedNotam['facilityTarget'];
  if (subject === 'NAV') {
    const aid = /^\s*NAV\s+(ILS|LOC|GP|GS|VOR\/DME|VOR|DME|TACAN|NDB)(?:\s+RWY\s+(\d{1,2}[LRC]?))?\s+U\/S\b/i.exec(content);
    if (aid) {
      if (aid[2]) {
        flair(`RWY ${aid[2].toUpperCase()}`, aid, 'info');
        facilityTarget = { facility: aid[1]!.toUpperCase(), runway: normalizeRunway(aid[2]) };
      }
      flair(`${aid[1]!.toUpperCase()} Unavailable`, aid);
    }
  }
  if (subject === 'OBST') {
    const lights = /^\s*OBST\s+(?:TOWERS?|POLES?|CRANES?|STACKS?|BLDGS?|BUILDINGS?|WIND TURBINES?|WINDMILLS?|RIGS?|TREES?)\s+LGT\b/i.exec(content);
    if (lights) {
      const outage = /\sU\/S(?:\s+\d{10}-\d{10}(?:EST)?)?\s*\.?\s*$/i.exec(content);
      if (outage && !/\b(?:NOT|IF|WHEN|UNLESS|EXC|EXCEPT|DISREGARD|DELETE|NOTE)\b/i.test(content)) addFlair('Obstacle Light Outage', 'caution', evidence(body, header, outage.index + outage[0].length));
      else flair('Obstacle Lighting', lights, 'info');
    }
    flair('Crane', /^\s*OBST\s+CRANE\b/i.exec(content));
    if (!/\b(?:NOT|IF|WHEN|UNLESS|EXC|EXCEPT|DISREGARD|DELETE|NOTE)\b/i.test(content)) {
      flair('Flagged and Lighted', /\bFLAGGED\s+AND\s+LGTD\b/i.exec(content), 'neutral');
    }
  }
  if (subject === 'AIRSPACE') {
    flair('UAS Activity', /^\s*AIRSPACE\s+UAS\b/i.exec(content));
    flair('Parachute Activity', /^\s*AIRSPACE\s+PJE\b/i.exec(content));
    const height = /^\s*AIRSPACE\s+UAS\b[^\n;]*?\bSFC-(\d{1,5})\s*FT\s+AGL\b/i.exec(content);
    if (height) flair(`Surface to ${height[1]} ft AGL`, height, 'neutral');
  }
  if (procedureNotice) {
    // Quoted/deleted/conditional values are not evidence of an operative minimum.
    const numericContent = content.split(/\b(?:ADD|CHANGE|DELETE|DISREGARD|NOTE|NOTES|WHEN|UNLESS|EXC|EXCEPT|PROVIDED)\b|\bIF\s+|\bFOR\s+INOP/i, 1)[0]!;
    flair('Minima Amended', /\b(?:DA|MDA)\s+\d+(?:\/|\b)/i.exec(numericContent));
    flair('Visibility Amended', /\b(?:VIS(?:IBILITY)?\s+(?:(?:ALL\s+)?CATS?\s+[A-D/ ]{0,16})?(?:RVR\s+)?\d|RVR\s+\d)/i.exec(numericContent));
    flair('Sidestep Minima', /\bSIDESTEP\s+\d{1,2}[LRC]?\s+MDA\s+\d+/i.exec(numericContent));
    flair('Circling Minima', /\bCIRCLING\s+CAT\s+[A-D]\s+MDA\s+\d+/i.exec(numericContent));
    flair('VDP Amended', /\bVDP\s+(?:AT\s+)?\d+(?:\.\d+)?NM\b/i.exec(numericContent));
    flair('Takeoff Minima Amended', /\bTAKE-?OFF\s+MINIMUMS\s*:?\s*RWY\s+\d{1,2}[LRC]?\s*,\s*\d/i.exec(numericContent));
    flair('Climb Gradient', /\b(?:MINIMUM\s+)?CLIMB\s+OF\s+\d+\s*(?:FT|FEET)(?:\/|\s+PER\s+)NM\b/i.exec(numericContent));
    flair('Crane', /\bTEMP(?:ORARY)?\s+CRANES?\b/i.exec(content));
    flair('Inoperative Lighting Note', /\bFOR\s+INOP\s+(?:ALS|MALSR|MALSF|ALSF-[12]|REIL)\b/i.exec(content));
    flair('Terminal Route Unavailable', /\bTERMINAL\s+ROUTE:\s*FROM\s+[A-Z0-9]+(?:\s*\([A-Z]+\))?\s+TO\s+[A-Z0-9]+(?:\s*\([A-Z]+\))?\s+NA\b/i.exec(numericContent));
    if (subject === 'IAP') flair('Circling Restriction', /\bCIRCLING\s+(?:TO\s+[A-Z0-9 ,/]{1,60}\s+)?NA\b/i.exec(numericContent));
    if (subject === 'SID' || subject === 'STAR') flair('Transition Restriction', /\b[A-Z0-9]+\s+TRANSITION\s+NA\b/i.exec(numericContent));
  }
  flair('Pointer', /\bSEE\s+(?:FDC\s+)?\d+\/\d+\b/i.exec(content), 'neutral');
  const result = { body, subject, flairs, targets, broad, broadRestricted, procedureNotice,
    runwayTargets: runway?.[1]?.split('/').map(normalizeRunway) ?? [],
    ...(facilityTarget ? { facilityTarget } : {}),
    unresolved: !subject || procedureNotice && !targets.length && !broad || broadRestricted ||
      subject === 'NAV' && (!facilityTarget || !['ILS', 'LOC', 'GP', 'GS'].includes(facilityTarget.facility)) ||
      limited || flairLimit || body.length - header > MAX_PARSE_LENGTH };
  parsedRecords.set(record, result);
  return result;
}

export function normalizeRunway(value: string): string { return value.toUpperCase().replace(/^0(?=\d)/, ''); }
