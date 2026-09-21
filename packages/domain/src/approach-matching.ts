import type { ApproachAssociations, ApproachRoute, ApproachRoutesData } from '@zlayer/contracts';
import { approachIndex } from './terminal-index.js';

const title = (name: string) => name.trim().toUpperCase().replace(/\s+/g, ' ').replace(/, CONT\.\d+$/, '');

/** Preserve the approach family, runway and variant. Operational qualifiers
 * must not turn an unrelated procedure into a match. */
export function approachIdent(name: string): string | undefined {
  let normalized = title(name);
  // SA Category I uses the Category I ILS coding. Keep the original chart title
  // on the selection; this association says nothing about operating approval.
  if (normalized.startsWith('ILS ')) normalized = normalized.replace(/ \(SA CAT I\)$/, '');
  const helicopter = /^COPTER RNAV \(GPS\) (\d{3})$/.exec(normalized);
  if (helicopter) return Number(helicopter[1]) > 0 && Number(helicopter[1]) <= 360 ? `R${helicopter[1]}` : undefined;
  const combined = /^ILS(?: ([A-Z]))? OR LOC(?:\/(?:DME|NDB))?(?: ([A-Z]))? ((?:RWY\s+)?\d{1,2}[LCR]?)$/.exec(normalized);
  if (combined) {
    if (combined[1] && combined[2] && combined[1] !== combined[2]) return undefined;
    const variant = combined[1] ?? combined[2];
    normalized = `ILS ${variant ? `${variant} ` : ''}${combined[3]}`;
  }
  const conventional = /^(VOR(?:\/DME)?|NDB(?:\/DME)?)(?: ([A-Z]))? OR (GPS|TACAN)(?: ([A-Z]))?([ -].+)$/.exec(normalized);
  if (conventional) {
    if (conventional[1]!.startsWith('NDB') && conventional[3] === 'TACAN' ||
      conventional[2] && conventional[4] && conventional[2] !== conventional[4]) return undefined;
    const variant = conventional[2] ?? conventional[4];
    normalized = `${conventional[1]}${variant ? ` ${variant}` : ''}${conventional[5]}`;
    // A combined VOR/TACAN/GPS circling chart retains the VOR identifier.
    if (conventional[3] === 'TACAN' && !variant) normalized = normalized.replace(/^VOR OR GPS-/, 'VOR-');
  }
  const circle = /^(RNAV \(GPS\)|VOR\/DME|VOR|LOC(?:\/DME)? BC|LOC(?:\/DME)?|LDA(?:\/DME)?|NDB(?:\/DME)?|GPS)-([A-Z])$/.exec(normalized);
  if (circle) {
    const type = circle[1]!.replace(/^(LOC|LDA)\/DME/, '$1');
    return `${({ 'RNAV (GPS)': 'RNV', 'VOR/DME': 'VDM', 'NDB/DME': 'NDM', 'LOC BC': 'LBC' } as Record<string, string>)[type] ?? type}-${circle[2]}`;
  }
  const match = /^(ILS|LOC(?:\/DME)?(?: BC)?|LDA(?:\/DME)?|SDF|RNAV \((?:GPS|RNP)\)|GPS|VOR(?:\/DME)?|NDB(?:\/DME)?)\s+(?:([A-Z])\s+)?(?:RWY\s+)?(\d{1,2}[LCR]?)$/.exec(normalized);
  if (!match) return undefined;
  const type = match[1] === 'ILS' ? 'I' : match[1]!.includes('BC') ? 'B' : match[1]!.startsWith('LOC') ? 'L'
    : match[1]!.startsWith('LDA') ? 'X' : match[1] === 'SDF' ? 'U'
    : match[1]!.includes('RNP') ? 'H' : match[1]!.startsWith('RNAV') ? 'R'
    : match[1] === 'VOR/DME' ? 'D' : match[1] === 'VOR' ? 'S' : match[1] === 'NDB/DME' ? 'Q' : match[1] === 'NDB' ? 'N' : 'P';
  const runway = match[3]!.replace(/^(\d)(?=[LCR]|$)/, '0$1');
  if (Number.parseInt(runway) < 1 || Number.parseInt(runway) > 36) return undefined;
  return `${type}${runway}${match[2] ? `${runway.length === 2 ? '-' : ''}${match[2]}` : ''}`;
}

/** All verified choices for a chart; distinct parallel-runway branches require
 * an explicit selection rather than an arbitrary first match. */
export function findApproachRoutes(data: ApproachRoutesData | undefined, airport: string, name: string): ApproachRoute[] {
  if (!data) return [];
  const unique = (ident: string | undefined) => {
    const matches = ident ? approachIndex(data).byAirport.get(airport)?.filter(p => p.ident === ident) ?? [] : [];
    return matches.length === 1 ? matches[0] : undefined;
  };
  const canonical = unique(approachIdent(name));
  if (canonical) return [canonical];
  // A shared L/R chart can use one source route only if BOTH complete coded
  // routes agree, including altitude constraints, transitions and missed legs.
  const parallel = /^(.* RWY \d{2})([LCR])\/([LCR])$/.exec(title(name));
  if (!parallel || parallel[2] === parallel[3]) return [];
  const first = unique(approachIdent(parallel[1]! + parallel[2]));
  const second = unique(approachIdent(parallel[1]! + parallel[3]));
  if (!first || !second) return [];
  return first.magneticVariation === second.magneticVariation &&
    JSON.stringify(first.transitions) === JSON.stringify(second.transitions) && JSON.stringify(first.final) === JSON.stringify(second.final)
    ? [first] : [first, second];
}

/** Current publications own chart associations. An unmatched record or a join
 * against another navigation generation cannot fall back to title guessing. */
export function publishedApproachRoutes(data: ApproachRoutesData | undefined, associations: ApproachAssociations | undefined,
  procedureId: string, terminalJsonSha256: string | undefined): ApproachRoute[] {
  if (!data || !associations || associations.effectiveDate !== data.metadata.effectiveDate ||
      associations.sources.terminalJsonSha256 !== terminalJsonSha256) return [];
  const record = associations.records.find(r => r.procedureId === procedureId);
  if (!record) return [];
  const index = approachIndex(data).byId;
  const matches = record.routeIds.map(id => index.get(id));
  return matches.every((p): p is ApproachRoute => p !== undefined && p.airport === record.airport) ? matches : [];
}

export function findApproachRoute(data: ApproachRoutesData | undefined, airport: string, name: string): ApproachRoute | undefined {
  const choices = findApproachRoutes(data, airport, name);
  return choices.length === 1 ? choices[0] : undefined;
}
