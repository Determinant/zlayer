import { evidence, type NotamTarget } from './interpretation';
import { isApproachTitle } from './procedure-title';
import { operativePrefix } from './clauses';

const MAX_HEADING_LENGTH = 320, MAX_TARGETS = 16;
const incidentalHeading = /\b(?:MISSED|EXC|EXCEPT|OBST|CRANE|NOTE|TRANSITION|CIRCLING|SEE|SPECIAL)\b/i;
// A later quoted or conditional procedure name is not another affected heading.
const headingNarrative = /\b(?:MISSED|EXC|EXCEPT|EXCLUDING|OBST|CRANES?|NOTES?|TRANSITIONS?|CIRCLING|SEE|DISREGARD|DELETE|REMOVE|ADD|CHANGE|IF|WHEN|UNLESS|PROVIDED|LNAV|LPV|VDP|CHART)\b|\b(?:THIS IS|EQUIPMENT REQUIREMENTS)\b|\bRNP\s+[.\d]|\bS-(?:ILS|LOC)\b/i;
const amendmentText = '(?:(?:AMDT\\s*|AMT\\s+)([0-9]+[A-Z]?)|(?:AMDT\\s*)?ORIG(?:INAL)?(?:[- ]([A-Z0-9]+))?)';
const amendmentSuffix = new RegExp(`(?:,\\s*|\\s+)${amendmentText}\\s*$`, 'i');
const amendmentOnly = new RegExp(`^\\s*${amendmentText}\\s*$`, 'i');
const amendmentValue = (match: RegExpExecArray) => match[1] ?? (match[2] ? `ORIG-${match[2]}` : 'ORIG');
const namedTitle = /^\s*([A-Z][A-Z0-9 '\n-]{1,100}?)\s+(?:RNAV\s+)?(DEPARTURE|DEP|ARRIVAL|ARR)(?:\s*\(RNAV\))?(?:\s*,\s*AMDT\s+([A-Z0-9-]+))?(?:\s+(NOT AUTHORIZED|NA))?\s*$/i;

export function procedureTargets(content: string, subject: string | undefined, body: string, header: number) {
  // Recognize an initial airport/city/state envelope as a whole. Periods in an
  // airport name (e.g. DANIEL K. INOUYE) are not procedure boundaries.
  if (subject === 'SID' || subject === 'STAR') {
    const preamble = /^\s*(?:SID|STAR)\s+[^,\n]{1,200}\b(?:AIRPORT|INTL|REGNL|MUNICIPAL|FIELD),\s+[A-Z][A-Z .'-]{0,70}?\s+(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\s+/i.exec(content);
    if (preamble && !/\b(?:IF|WHEN|UNLESS|EXCEPT|NOT|SEE|NOTE)\b/i.test(preamble[0])) {
      content = content.slice(preamble[0].length); header += preamble[0].length;
    }
  }
  const targets: NotamTarget[] = []; let limited = false;
  const operative = operativePrefix(content.split(/\bEND PART\b/i, 1)[0]!);
  const namedHeadingStop = incidentalHeading.exec(operative)?.index ?? operative.length;
  const add = (title: string, start: number, amendment?: string) => {
    const existing = targets.findIndex(t => t.title === title && t.amendment === amendment);
    if (existing >= 0) return existing;
    if (targets.length >= MAX_TARGETS) { limited = true; return; }
    targets.push({ title, ...(amendment ? { amendment } : {}), evidence: evidence(body, header + start, title.length) });
    return targets.length - 1;
  };
  if (subject === 'IAP') {
    // Parse each heading independently, with or without an amendment. One valid
    // heading does not establish coverage of the rest of a multi-procedure notice.
    const stop = headingNarrative.exec(operative)?.index ?? operative.length;
    let previous: { indexes: number[]; end: number } | undefined;
    for (const clause of content.slice(0, stop).replace(/\s+-\s*$/, '').matchAll(/[^.\n;]+/g)) {
      const source = clause[0], offset = clause.index;
      if (source.length > MAX_HEADING_LENGTH) { limited = true; continue; }
      const standalone = amendmentOnly.exec(source);
      if (standalone && previous && /^\.\s*$/.test(content.slice(previous.end, offset))) {
        for (const index of previous.indexes) targets[index]!.amendment = amendmentValue(standalone);
        previous = undefined; continue;
      }
      const pieces = [...source.matchAll(/[^,]+/g)].map(piece => {
        const wholeAmendment = amendmentOnly.exec(piece[0]);
        const amendment = wholeAmendment ?? amendmentSuffix.exec(piece[0]);
        const title = (wholeAmendment ? '' : amendment ? piece[0].slice(0, amendment.index) : piece[0]).replace(/^\s*IAP\s+/, '').trim();
        return { title, start: offset + piece.index + piece[0].indexOf(title), amendment, valid: !!wholeAmendment || isApproachTitle(title) };
      });
      previous = undefined;
      // A comma list must consist entirely of complete titles and amendments.
      // Do not rescue a familiar title following an unknown/conditional prefix.
      if (!pieces.length || pieces.some(p => !p.valid) || !pieces[0]!.title) {
        if (amendmentSuffix.test(source) || /\bRWY\s+\d{1,2}[LRC]?\s*$/i.test(source)) limited = true;
        continue;
      }
      let pending: number[] = [];
      for (const piece of pieces) {
        if (piece.title) { const index = add(piece.title, piece.start); if (index !== undefined) pending.push(index); }
        if (piece.amendment) {
          for (const index of pending) targets[index]!.amendment = amendmentValue(piece.amendment);
          pending = [];
        }
      }
      if (pending.length) previous = { indexes: pending, end: offset + source.trimEnd().length };
    }
    return { targets, limited };
  }
  if (subject === 'ODP' || subject === 'DVA') {
    const stop = headingNarrative.exec(operative)?.index ?? operative.length;
    let previous: { index: number; end: number } | undefined;
    for (const clause of content.slice(0, stop).matchAll(/[^.\n;]+/g)) {
      const source = clause[0], amendment = amendmentSuffix.exec(source);
      const standalone = amendmentOnly.exec(source);
      if (standalone && previous && /^\.\s*$/.test(content.slice(previous.end, clause.index))) {
        targets[previous.index]!.amendment = amendmentValue(standalone);
        previous = undefined; continue;
      }
      previous = undefined;
      const title = (amendment ? source.slice(0, amendment.index) : source.replace(/\s+AMDT\s*$/i, '')).trim();
      if (/^(?:(?:IFR )?TAKE-?OFF MINIMUMS(?: AND \(OBSTACLE\) DEPARTURE PROCEDURES)?|DIVERSE VECTOR AREA(?:\s*\((?:DVA|RADAR VECTORS)\))?)$/i.test(title)) {
        const index = add(title, clause.index + source.indexOf(title), amendment ? amendmentValue(amendment) : undefined);
        if (!amendment && index !== undefined) previous = { index, end: clause.index + source.trimEnd().length };
        if (!amendment && /\bAMDT\s*$/i.test(source)) limited = true;
      }
    }
    if (targets.length || subject === 'DVA') return { targets, limited };
  }
  if (subject === 'SID' || subject === 'STAR' || subject === 'ODP') {
    // A line wrap is not a heading boundary. Require a complete name and
    // procedure type, ending at punctuation or an explicit prohibition.
    for (const clause of content.slice(0, namedHeadingStop).matchAll(/[^.:;]+/g)) {
      if (clause[0].length > MAX_HEADING_LENGTH) continue;
      const heading = clause.index === 0 ? clause[0].replace(/^\s*(?:SID|STAR|ODP)\s+/, '') : clause[0];
      const whole = namedTitle.exec(heading);
      // Airport context occasionally ends at a line break, without a period.
      // Only the initial, comma-bearing airport clause can use this boundary;
      // never discard an arbitrary prefix from a later affected heading.
      const candidates = whole ? [whole] : clause.index === 0 && clause[0].includes(',')
        ? clause[0].split('\n').map(line => namedTitle.exec(line)).filter(m => m !== null) : [];
      for (const named of candidates) {
        if (!named[4] && !/[.:;]/.test(content[clause.index + clause[0].length] ?? '')) continue;
        if ((subject !== 'STAR') !== /^(?:DEP|DEPARTURE)$/i.test(named[2]!)) continue;
        const title = named[1]!.trim(); add(title, clause.index + clause[0].indexOf(title), named[3]);
      }
    }
  }
  if (subject === 'ODP') return { targets, limited };
  // Scan delimiters once, then apply title grammar only to a bounded prefix.
  // An unanchored "anything before AMDT" expression retries every suffix of a long line.
  for (const line of content.slice(0, namedHeadingStop).matchAll(/[^\n;]+/g)) {
    const text = line[0], offset = line.index!;
    let start = 0;
    for (const marker of text.matchAll(/,\s*(?:AMDT\s+([A-Z0-9-]+)|ORIG(?:INAL)?(?:-([A-Z0-9]+))?)\b/gi)) {
      const prefix = text.slice(start, marker.index), prefixStart = start;
      start = marker.index! + marker[0].length;
      if (prefix.length > MAX_HEADING_LENGTH) { limited = true; continue; }
      const approach = isApproachTitle(prefix) ? prefix.trim() : undefined;
      const named = subject !== 'IAP' ? /(?:^|,)\s*([A-Z][A-Z0-9 .'-]{1,100}?(?:\s*\((?:RNAV|[A-Z0-9.]+)\))?)\s*$/i.exec(prefix) : null;
      const title = approach ?? named?.[1]?.trim();
      if (!title || incidentalHeading.test(prefix.slice(0, prefix.lastIndexOf(title)))) continue;
      add(title, offset + prefixStart + prefix.lastIndexOf(title), marker[1] ?? (marker[2] ? `ORIG-${marker[2]}` : 'ORIG'));
    }
  }
  return { targets, limited };
}
