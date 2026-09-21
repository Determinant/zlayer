import type { ApproachFix, ApproachRoutesData, TerminalProceduresData } from '@zlayer/contracts';
import { terminalFixId } from './terminal-fixes.js';

function grouped<T>(values: readonly T[], key: (value: T) => string): ReadonlyMap<string, readonly T[]> {
  const index = new Map<string, T[]>();
  for (const value of values) {
    const id = key(value), matches = index.get(id);
    if (matches) matches.push(value); else index.set(id, [value]);
  }
  return index;
}
const approaches = new WeakMap<ApproachRoutesData, ReturnType<typeof prepareApproaches>>();
function prepareApproaches(data: ApproachRoutesData) {
  return { byId: new Map(data.procedures.map(p => [p.id, p])), byAirport: grouped(data.procedures, p => p.airport) };
}
export function approachIndex(data: ApproachRoutesData) {
  let index = approaches.get(data);
  if (!index) { index = prepareApproaches(data); approaches.set(data, index); }
  return index;
}
const terminals = new WeakMap<TerminalProceduresData, ReturnType<typeof prepareTerminals>>();
function prepareTerminals(data: TerminalProceduresData) {
  // Saved decomposed fixes need national membership checks. Ordinary previews
  // carry their selected endpoints directly and never force this leg traversal.
  let fixes: ReadonlyMap<string, ApproachFix> | undefined;
  return {
    nasrByIdent: grouped(data.procedures, p => p.ident),
    codedById: new Map(data.codedProcedures?.procedures.map(p => [p.id, p])),
    codedByAirport: grouped(data.codedProcedures?.procedures ?? [], p => p.airport),
    fix(id: string): ApproachFix | undefined {
      if (!id.startsWith('approach-fix:')) return;
      if (!fixes) {
        const index = new Map<string, ApproachFix>();
        const add = (fix: ApproachFix | undefined) => { if (fix) index.set(terminalFixId(fix), fix); };
        for (const p of data.approaches?.procedures ?? []) {
          for (const branch of p.transitions) for (const leg of branch.legs) add(leg.fix);
          for (const leg of p.final) add(leg.fix);
        }
        for (const p of data.codedProcedures?.procedures ?? []) {
          for (const runway of p.runways ?? []) add(runway);
          for (const branch of p.branches) for (const leg of branch.legs) add(leg.fix);
        }
        fixes = index;
      }
      return fixes.get(id);
    },
  };
}
/** Document objects are immutable after validation. Index lifetime follows the
 * document, so airport pickers do not retain a separate national feature graph. */
export function terminalIndex(data: TerminalProceduresData) {
  let index = terminals.get(data);
  if (!index) { index = prepareTerminals(data); terminals.set(data, index); }
  return index;
}
