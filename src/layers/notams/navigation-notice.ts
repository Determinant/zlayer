import type { NotamRecord } from '@zlayer/contracts';
import { evidence, type NotamEvidence } from './interpretation';

export type NotamNavigation = {
  facility: string; components: string[]; station?: string; runway?: string; variant?: string; locator?: string;
  sourceReference?: string;
  effect: 'unavailable' | 'unmonitored' | 'decommissioned' | 'restricted';
  qualification?: string; evidence: NotamEvidence;
  sourceInterval?: string;
  sourceEffect: 'U/S' | 'UNSERVICEABLE' | 'UNUSABLE' | 'NOT MNT' | 'DECOMMISSIONED';
};
const facilities = new Set(['ILS', 'LOC', 'GP', 'GS', 'VOR', 'VOR/DME', 'VORTAC', 'DME', 'TACAN', 'NDB', 'LOM', 'VOT', 'GBAS']);
const parts: Record<string, readonly string[]> = {
  ILS: ['LOC', 'GP', 'GS', 'DME', 'OM', 'IM', 'MM', 'LOM', 'BC'],
  LOC: ['LOC', 'DME', 'OM', 'IM', 'MM', 'LOM', 'BC'], TACAN: ['AZM', 'DME'],
};
const isIdent = (value = '') => /^[A-Z0-9]{2,5}$/.test(value) && !['NOTE', 'WHEN', 'IF', 'NOT', 'SEE', 'DELETE', 'CHANGE', 'ADD'].includes(value);

/** Heading -> facility -> runway -> component -> effect -> qualification.
 * Component lists are consumed atomically. A locator name is not a component,
 * and a restriction never becomes an unconditional outage. All evidence addresses
 * the original body; the folded token stream is only a comparison view. */
export function navigationNotice(content: string, record: Pick<NotamRecord, 'locations' | 'icaoLocations'>,
  body = content, offset = 0): NotamNavigation | undefined {
  if (content.length > 64 * 1024) return;
  const matches = [...content.matchAll(/\S+/g)], tokens = matches.map(m => m[0].toUpperCase());
  let at = 0, station: string | undefined, runway: string | undefined, variant: string | undefined, locator: string | undefined;
  let sourceReference: string | undefined;
  const associated = (id: string) => [...record.locations, ...record.icaoLocations].includes(id);
  const slashed = /^\/([A-Z0-9]{2,5})\/$/.exec(tokens[at] ?? '');
  // A slash wrapper can name an airport while the next field names its navaid
  // (e.g. /RYN/ NAV RBJ NDB). Preserve it without relabeling the station.
  if (slashed) { sourceReference = slashed[1]; at++; }
  else if (associated(tokens[at] ?? '') && !facilities.has(tokens[at]!)) sourceReference = tokens[at++];
  else if (tokens[at + 1] === 'NAV' && isIdent(tokens[at]) && !facilities.has(tokens[at]!)) station = tokens[at++];
  const headed = tokens[at] === 'NAV' || tokens[at] === 'NAVAID';
  if (headed) at++;
  if (!headed && !station && !sourceReference) return;
  // Observed source order NAV RWY 09 ILS U/S still supplies both identities.
  if (tokens[at] === 'RWY') {
    const id = /^(?:0?[1-9]|[12]\d|3[0-6])[LRC]?$/.exec(tokens[at + 1] ?? '');
    if (!id || !['ILS', 'LOC', 'GP', 'GS'].includes(tokens[at + 2] ?? '')) return;
    runway = id[0]; at += 2;
  }
  // A named station may follow NAV; another NAV may follow that station in
  // published redundant wrappers, but it cannot recur after the facility.
  if (!facilities.has(tokens[at]!) && isIdent(tokens[at]) &&
      (facilities.has(tokens[at + 1]!) || tokens[at + 1] === 'NAV')) {
    if (station && station !== tokens[at]) return;
    station ??= tokens[at]; at++;
    if (tokens[at] === 'NAV') at++;
  }
  let facility = tokens[at++];
  if (facility === 'LOC' && tokens.slice(at, at + 3).join(' ') === 'TYPE DIRECTIONAL AID') {
    facility = 'LDA'; at += 3;
  } else if (!facility || !facilities.has(facility)) return;
  if (tokens[at] === 'RWY') {
    const id = /^(0?[1-9]|[12]\d|3[0-6])([LRC]?)(?:\(([A-Z])\))?$/.exec(tokens[++at] ?? '');
    if (!id || runway) return;
    runway = id[1]! + id[2]!; variant = id[3]; at++;
  }
  let components: string[] = [];
  const allowed = parts[facility] ?? [];
  if (allowed.includes('OM') && tokens[at] === 'OUTER' && tokens[at + 1] === 'MARKER') { components = ['OM']; at += 2; }
  else if (allowed.includes(tokens[at + 1] ?? '') && isIdent(tokens[at]) && !allowed.includes(tokens[at]!)) {
    locator = tokens[at++]; components = [tokens[at++]!];
  } else if ((tokens[at] ?? '').split('/').every(p => allowed.includes(p))) {
    components = tokens[at++]!.split('/');
    if (new Set(components).size !== components.length) return;
  }
  // A named LOM may explicitly identify its NDB implementation.
  if (tokens[at] === 'NDB' && (components.includes('LOM') || facility === 'LOM' || facility === 'NDB')) at++;
  let qualification: string | undefined;
  if (tokens.slice(at, at + 3).join(' ') === 'GND REC CHECKPOINT' && facility === 'VOR') {
    at += 3; qualification = 'GND REC CHECKPOINT';
    if (tokens[at] === 'FOR' && tokens[at + 1] === 'TWY' && /^[A-Z0-9]+$/.test(tokens[at + 2] ?? '')) {
      qualification += ` FOR TWY ${tokens[at + 2]}`; at += 3;
    }
  }
  // Explicit radial/distance/altitude coverage precedes UNUSABLE. Consume only
  // the published field sequence, never an arbitrary run of words before it.
  if (/^\d{3}-\d{3}$/.test(tokens[at] ?? '') && ['VOR', 'VORTAC', 'TACAN'].includes(facility)) {
    const radial = tokens[at++]!;
    if (radial.split('-').some(v => Number(v) > 360)) return;
    qualification = radial;
    if (tokens[at] === 'BEYOND' && /^\d+(?:\.\d+)?NM$/.test(tokens[at + 1] ?? '')) {
      qualification += ` BEYOND ${tokens[at + 1]}`; at += 2;
    }
    if (/^SFC-\d+FT$/.test(tokens[at] ?? '')) qualification += ` ${tokens[at++]}`;
  }
  const token = (tokens[at++] ?? '').replace(/\.$/, '');
  let effect: NotamNavigation['effect'];
  if (token === 'NOT' && tokens[at]?.replace(/\.$/, '') === 'MNT') { at++; effect = 'unmonitored'; }
  else if (['U/S', 'UNSERVICEABLE', 'UNUSABLE'].includes(token)) effect = qualification && !qualification.startsWith('GND REC') ? 'restricted' : 'unavailable';
  else if (token === 'DECOMMISSIONED') effect = 'decommissioned';
  else return;
  const tailStart = matches[at]?.index ?? content.length;
  const tail = content.slice(tailStart).trim().replace(/\.$/, '');
  const sourceInterval = /^\d{10}-(?:\d{10}(?:EST)?|PERM)$/.test(tail) ? tail : undefined;
  if (tail && !sourceInterval) {
    if (!['UNUSABLE', 'U/S', 'NOT'].includes(token)) return;
    if (/^(?:DA TO TDZ|WI \.?\d+(?:\.\d+)?NM|BEYOND \d+(?:\.\d+)?DEG (?:LEFT|RIGHT) OF COURSE)$/.test(tail.toUpperCase())) {
      qualification = tail; effect = 'restricted';
    } else {
      // Keep qualified outages typed, but explicitly retain the whole published
      // exception/schedule. Unknown non-qualification suffixes reject the form.
      if (!/^(?:EXC|EXCEPT|WHEN|UNLESS|ONLY|DLY|MON|TUE|WED|THU|FRI|SAT|SUN|IF|PROVIDED)\b/i.test(tail)) return;
      qualification = qualification ? `${qualification} ${tail}` : tail; effect = 'restricted';
    }
  }
  return { facility, components, effect, evidence: evidence(body, offset, content.length),
    sourceEffect: (token === 'NOT' ? 'NOT MNT' : token) as NotamNavigation['sourceEffect'],
    ...(station ? { station } : {}), ...(runway ? { runway } : {}), ...(variant ? { variant } : {}),
    ...(sourceReference ? { sourceReference } : {}),
    ...(locator ? { locator } : {}), ...(qualification ? { qualification } : {}), ...(sourceInterval ? { sourceInterval } : {}) };
}
