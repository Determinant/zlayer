import type { ApproachRoute, ApproachRoutesData } from '@zlayer/contracts';

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

// Plate/source comparisons are recorded in docs/approach-coverage.md#reviewed-associations.
// These are edition-specific associations, never global variant/type fallbacks.
export const reviewedApproachAssociations = [
  ['K50', 'RNAV (GPS)-A', 'RNVA'],
  ['KPNS', 'VOR RWY 08', 'V08'], ['KSMX', 'VOR RWY 12', 'V12'], ['KTBN', 'VOR RWY 33', 'V33'],
  ['KPMD', 'VOR OR TACAN Z RWY 25', 'S25'],
  ['KSBD', 'ILS OR LOC Z RWY 06', 'I06'], ['KSLE', 'ILS OR LOC Z RWY 31', 'I31'],
  ['PASD', 'NDB RWY 32', 'Q32'], ['PGSN', 'NDB Z RWY 07', 'Q07-Z'],
  ['PGUM', 'NDB RWY 24R', 'Q24R'], ['PTKK', 'NDB RWY 22', 'Q22'],
  ['KNOW', 'COPTER RNAV (GPS) RWY 26', 'R26'],
  ['KWAY', 'COPTER RNAV (GPS) Y RWY 09', 'R09-Y'], ['W99', 'COPTER RNAV (GPS) X RWY 31', 'R31-X'],
  ['KAST', 'COPTER LOC RWY 26', 'L26'], ['KHUM', 'COPTER VOR RWY 12', 'S12'],
  ['KEWR', 'COPTER ILS Y OR LOC Y RWY 04L', 'I04LY'], ['KMKT', 'COPTER ILS Z OR LOC Z RWY 33', 'I33-Z'],
  ['KOTH', 'COPTER ILS Y OR LOC Y RWY 05', 'I05-Y'], ['KRST', 'COPTER ILS Y OR LOC Y RWY 31', 'I31-Y'],
  ['KTEB', 'COPTER ILS Y OR LOC Y RWY 06', 'I06-Y'], ['KMSP', 'ILS RWY 35 (SA CAT I)', 'I35-Z'],
  // These four have their own V variant in this CIFP, despite the readme's
  // general exclusion of converging ILS. Ordinary ILS routes are not substitutes.
  ['KDFW', 'ILS V RWY 13R (CONVERGING)', 'I13RV'], ['KMSP', 'ILS V RWY 35 (CONVERGING)', 'I35-V'],
  ['KPHL', 'ILS V RWY 09R (CONVERGING)', 'I09RV'], ['KPHL', 'ILS V RWY 17 (CONVERGING)', 'I17-V'],
] as const;

/** All verified choices for a chart; distinct parallel-runway branches require
 * an explicit selection rather than an arbitrary first match. */
export function findApproachRoutes(data: ApproachRoutesData | undefined, airport: string, name: string): ApproachRoute[] {
  if (!data) return [];
  const unique = (ident: string | undefined) => {
    const matches = ident ? data.procedures.filter(p => p.airport === airport && p.ident === ident) : [];
    return matches.length === 1 ? matches[0] : undefined;
  };
  const canonical = unique(approachIdent(name));
  if (canonical) return [canonical];
  if (data.metadata.effectiveDate === '2026-09-03') {
    const reviewed = reviewedApproachAssociations.find(([a, n]) => a === airport && n === title(name));
    if (reviewed) {
      const procedure = unique(reviewed[2]);
      return procedure ? [procedure] : [];
    }
  }
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

export function findApproachRoute(data: ApproachRoutesData | undefined, airport: string, name: string): ApproachRoute | undefined {
  const choices = findApproachRoutes(data, airport, name);
  return choices.length === 1 ? choices[0] : undefined;
}
