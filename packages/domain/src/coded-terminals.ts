export { terminalConstraint } from './procedure-constraints.js';
import type { ApproachLeg, CodedTerminalBranch, CodedTerminalProcedure, TerminalProceduresData } from '@zlayer/contracts';
import { resolveApproachLegs } from './approach-path.js';
import { distanceNm } from './route.js';
import { terminalFixFeature as approachFixFeature } from './terminal-fixes.js';
import { terminalIndex } from './terminal-index.js';
import type { RouteTerminal } from './route-model.js';
import type { RouteOwner, RouteAtom } from './route-source.js';

export type TerminalPath = {
  id: string; branches: string[]; runway: string; runwayId: string; transition: string; transitionName: string;
  sourceRunway?: string;
  legs: ApproachLeg[];
};
const groups = {
  departure: ['123', '456', 'FMS', 'RNP', 'T V'],
  arrival: ['321', '654', '987', 'SMF', 'PNR'],
} as const;

/** Runway, common, enroute identities are taken from route types, never proximity.
 * Families stay separate and an IF join must agree with its preceding fix. */
export function terminalPaths(procedure: CodedTerminalProcedure): TerminalPath[] {
  const paths: TerminalPath[] = [];
  for (const family of groups[procedure.kind]) {
    const candidates = [...family].map(type => procedure.branches.filter(b => b.routeType === type));
    if (candidates.every(list => !list.length)) continue;
    const options = candidates.map(list => list.length ? list : [undefined]);
    for (const runway of options[0]!) for (const common of options[1]!) for (const enroute of options[2]!) {
      const ordered = (procedure.kind === 'departure' ? [runway, common, enroute] : [enroute, common, runway])
        .filter((b): b is CodedTerminalBranch => b !== undefined);
      if (ordered.some((b, i) => i > 0 && !canJoin(ordered[i - 1]!, b))) continue;
      const legs = ordered.flatMap(b => b.legs);
      const edge = procedure.kind === 'departure' ? legs.at(-1) : legs[0];
      const transition = enroute?.transition || (edge?.path !== 'VM' && edge?.path !== 'FM' ? edge?.fix?.ident : undefined) || '';
      const branches = ordered.map(b => b.id);
      const runwayName = runway?.transition || common?.transition || 'ALL';
      const surveyed = (procedure.runways ?? []).filter(r => runwayName === 'ALL' ||
        r.ident === runwayName || /^RW\d{2}B$/.test(runwayName) &&
        r.ident.slice(0, 4) === runwayName.slice(0, 4) && /[LR]$/.test(r.ident));
      // A vectors/climb departure starts at the selected threshold, not the ARP.
      const runwayOptions = procedure.kind === 'departure' ? surveyed.length ? surveyed : [undefined] : [undefined];
      for (const threshold of runwayOptions) {
        const sourceRunway = threshold?.ident;
        const name = sourceRunway ?? runwayName;
        const seeded = threshold && !legs[0]?.fix ? [{ path: 'IF', fix: threshold }, ...legs] : legs;
        paths.push({ id: JSON.stringify([sourceRunway ?? '', ...branches]), branches,
          runway: name, runwayId: JSON.stringify([name, runway?.id, common?.id, family]),
          ...(sourceRunway ? { sourceRunway } : {}),
          transition, transitionName: transition || 'Vectors', legs: seeded });
      }
    }
  }
  return paths;
}

function canJoin(a: CodedTerminalBranch, b: CodedTerminalBranch): boolean {
  const first = b.legs[0], last = a.legs.at(-1);
  if (first?.path !== 'IF' || !first.fix || !last?.fix || ['VM', 'FM'].includes(last.path)) return true;
  return first.fix.ident === last.fix.ident && distanceNm(first.fix.coordinate, last.fix.coordinate) < .01;
}

/** Supply published enroute endpoints before airway expansion. These are owned
 * by the airport attachment, never independent editable route tokens. */
export function codedTerminalAtoms(atoms: RouteAtom[], data: TerminalProceduresData | undefined,
  airportIds: (atom: RouteAtom) => (string | undefined)[]): RouteAtom[] {
  return atoms.flatMap((atom, index) => {
    const endpoint = (kind: 'departure' | 'arrival'): RouteAtom | undefined => {
      const selected = atom.entry?.[kind];
      if (selected?.source !== 'cifp') return;
      const path = selectedTerminalPath(selected, kind, data, airportIds(atom))?.path;
      if (!path || !selected.transition) return;
      const leg = kind === 'departure' ? path.legs.at(-1) : path.legs[0];
      if (!leg?.fix || ['VM', 'FM'].includes(leg.path) || atoms[index + (kind === 'departure' ? 1 : -1)]?.text === leg.fix.ident) return;
      const owner: RouteOwner = { kind: 'procedure', source: atom.source, ident: selected.ident };
      return { text: leg.fix.ident, terminalFix: leg.fix, pinnedFeatureId: approachFixFeature(leg.fix).id!, scope: atom.scope,
        source: atom.source, owners: [owner], incomingOwners: [], };
    };
    const before = endpoint('arrival'), after = endpoint('departure');
    return [...(before ? [before] : []), atom, ...(after ? [after] : [])];
  });
}


/** CIFP source adapter. Geometry is interpreted only after the exact edition,
 * airport, ordered branches and surveyed runway have been checked. */
function selectedTerminalPath(selection: RouteTerminal, kind: 'departure' | 'arrival',
  data: TerminalProceduresData | undefined, aliases: readonly (string | undefined)[]) {
  if (!data || selection.effectiveDate !== data.metadata.effectiveDate || !aliases.includes(selection.airportId)) return;
  const procedure = terminalIndex(data).codedById.get(selection.procedureId);
  if (!procedure || procedure.kind !== kind || procedure.airport !== selection.airportId) return;
  const path = terminalPaths(procedure).find(path => path.id === selection.branchId &&
    JSON.stringify(path.branches) === JSON.stringify(selection.codedBranches) && path.sourceRunway === selection.codedRunway);
  return path ? { procedure, path } : undefined;
}

export function selectedCodedTerminal(selection: RouteTerminal, kind: 'departure' | 'arrival',
  data: TerminalProceduresData | undefined, aliases: readonly (string | undefined)[]) {
  const selected = selectedTerminalPath(selection, kind, data, aliases);
  return selected ? { ...selected, preview: resolveApproachLegs(selected.procedure, selected.path.legs, { terminal: true }) } : undefined;
}

export function codedTerminalSelection(procedure: CodedTerminalProcedure, path: TerminalPath, effectiveDate: string, name = procedure.ident): RouteTerminal {
  return { kind: procedure.kind, source: 'cifp', airportId: procedure.airport, procedureId: procedure.id, ident: procedure.ident, name, effectiveDate,
    transition: path.transition, branchId: path.id, branchName: path.runway === 'ALL' ? 'All runways' : path.runway.replace(/^RW/, 'Runway '),
    codedBranches: path.branches, ...(path.sourceRunway ? { codedRunway: path.sourceRunway } : {}) };
}
