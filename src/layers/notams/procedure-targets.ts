import { evidence, type NotamTarget } from './interpretation';
import { isApproachTitle } from './procedure-title';
import { operativePrefix } from './clauses';

const MAX_HEADING_LENGTH = 320, MAX_TARGETS = 16;
const incidentalHeading = /\b(?:MISSED|EXC|EXCEPT|OBST|CRANE|NOTE|TRANSITION|CIRCLING|SEE|SPECIAL)\b/i;
// A later quoted or conditional procedure name is not another affected heading.
const headingNarrative = /\b(?:MISSED|EXC|EXCEPT|EXCLUDING|OBST|CRANES?|NOTES?|TRANSITIONS?|CIRCLING|SEE|DISREGARD|DELETE|REMOVE|ADD|CHANGE|IF|WHEN|UNLESS|PROVIDED|LNAV|LPV|VDP|CHART)\b|\b(?:THIS IS|EQUIPMENT REQUIREMENTS)\b|\bRNP\s+[.\d]|\bS-(?:ILS|LOC)\b/i;
const amendmentSuffix = /(?:,\s*|\s+)(?:AMDT\s+([A-Z0-9-]+)|ORIG(?:INAL)?(?:-([A-Z0-9]+))?)\s*$/i;
const namedTitle = /^\s*([A-Z][A-Z0-9 '\n-]{1,100}?)\s+(?:RNAV\s+)?(DEPARTURE|DEP|ARRIVAL|ARR)(?:\s*\(RNAV\))?(?:\s*,\s*AMDT\s+([A-Z0-9-]+))?(?:\s+(NOT AUTHORIZED|NA))?\s*$/i;

export function procedureTargets(content: string, subject: string | undefined, body: string, header: number) {
  const targets: NotamTarget[] = []; let limited = false;
  const operative = operativePrefix(content);
  const namedHeadingStop = incidentalHeading.exec(operative)?.index ?? operative.length;
  const add = (title: string, start: number, amendment?: string) => {
    if (targets.some(t => t.title === title && t.amendment === amendment)) return;
    if (targets.length >= MAX_TARGETS) { limited = true; return; }
    targets.push({ title, ...(amendment ? { amendment } : {}), evidence: evidence(body, header + start, title.length) });
  };
  if (subject === 'IAP') {
    // Parse each heading independently, with or without an amendment. One valid
    // heading does not establish coverage of the rest of a multi-procedure notice.
    const stop = headingNarrative.exec(operative)?.index ?? operative.length;
    for (const clause of content.slice(0, stop).matchAll(/[^.\n;]+/g)) {
      const source = clause[0], offset = clause.index;
      if (source.length > MAX_HEADING_LENGTH) { limited = true; continue; }
      const amendment = amendmentSuffix.exec(source);
      const heading = (amendment ? source.slice(0, amendment.index) : source).replace(/^\s*IAP\s+/, '');
      if (isApproachTitle(heading)) {
        const title = heading.trim();
        add(title, offset + source.indexOf(title), amendment ? amendment[1] ?? (amendment[2] ? `ORIG-${amendment[2]}` : 'ORIG') : undefined);
      } else if (amendment || /\bRWY\s+\d{1,2}[LRC]?\s*$/i.test(heading)) {
        // Preserve unsupported prefixes and compound headings as uncertainty;
        // never rescue a familiar suffix and claim the whole target was parsed.
        limited = true;
      }
    }
    return { targets, limited };
  }
  if (subject === 'SID' || subject === 'STAR') {
    // A line wrap is not a heading boundary. Require a complete name and
    // procedure type, ending at punctuation or an explicit prohibition.
    for (const clause of content.slice(0, namedHeadingStop).matchAll(/[^.:;]+/g)) {
      if (clause[0].length > MAX_HEADING_LENGTH) continue;
      const heading = clause.index === 0 ? clause[0].replace(/^\s*(?:SID|STAR)\s+/, '') : clause[0];
      const whole = namedTitle.exec(heading);
      // Airport context occasionally ends at a line break, without a period.
      // Only the initial, comma-bearing airport clause can use this boundary;
      // never discard an arbitrary prefix from a later affected heading.
      const candidates = whole ? [whole] : clause.index === 0 && clause[0].includes(',')
        ? clause[0].split('\n').map(line => namedTitle.exec(line)).filter(m => m !== null) : [];
      for (const named of candidates) {
        if (!named[4] && !/[.:;]/.test(content[clause.index + clause[0].length] ?? '')) continue;
        if ((subject === 'SID') !== /^(?:DEP|DEPARTURE)$/i.test(named[2]!)) continue;
        const title = named[1]!.trim(); add(title, clause.index + clause[0].indexOf(title), named[3]);
      }
    }
  }
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
