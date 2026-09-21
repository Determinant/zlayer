import type { TerminalProcedure, TerminalProcedureRoute, TerminalProceduresData } from '@zlayer/contracts';
import type { RouteDraft, RoutePlan } from './route-model.js';
import type { RouteAtom } from './route-source.js';

export type DepartureBranch = { id: string; name: string; route: TerminalProcedureRoute };

/** Retain published branch identity, independent of source array ordering. */
export function departureBranches(procedure: TerminalProcedure, airport: string): DepartureBranch[] {
  return procedure.routes.flatMap(route => route.kind === 'body'
    ? route.airports.filter(entry => entry.ident === airport).map(entry => ({
      id: `${route.bodySequence}:${route.name}:${entry.runway ?? ''}`, name: entry.runway ? `Runway ${entry.runway} · ${route.name}` : route.name, route,
    })) : []);
}

export function departureExits(procedure: TerminalProcedure, branch: DepartureBranch): string[] {
  const end = branch.route.points.at(-1);
  if (!end) return [];
  return [...new Set([end.ident, ...procedure.routes.filter(route => route.kind === 'transition' &&
    route.points[0]?.ident === end.ident && route.points[0]?.type === end.type && route.points[0]?.icaoRegion === end.icaoRegion)
    .flatMap(route => route.points.at(-1)?.ident ?? [])])];
}

/** Filing text is an import boundary; recognized SIDs become airport attachments. */
export function attachRouteDepartures(draft: RouteDraft, plan: RoutePlan, data?: TerminalProceduresData): RouteDraft {
  const entries = [...draft.entries];
  let changed = false;
  for (const resolved of [...plan.procedures].reverse()) {
    if (resolved.kind !== 'departure') continue;
    const index = resolved.tokenIndex, airport = draft.entries[index - 1], token = draft.entries[index];
    if (!airport || airport.departure || token?.text !== resolved.ident ||
      !plan.waypoints.some(point => point.edit?.entryId === airport.id && point.layer === 'airports')) continue;
    const matches = data?.procedures.filter(procedure => procedure.ident === resolved.ident &&
      procedure.kind === 'departure' && procedure.airports.includes(resolved.airport));
    if (matches?.length !== 1) continue;
    const procedure = matches[0]!;
    entries[index - 1] = { ...airport, departure: { airportId: resolved.airport, procedureId: procedure.id,
      ident: procedure.ident, name: procedure.name, effectiveDate: data!.metadata.effectiveDate, transition: resolved.transition } };
    entries.splice(index, 1);
    changed = true;
  }
  return changed ? { entries } : draft;
}

/** Supply the normal SID expander with internal procedure/exit atoms, retaining
 * the airport as their source and the only editable anchor. */
export function departureAtoms(atoms: RouteAtom[]): RouteAtom[] {
  return atoms.flatMap((airport, index) => {
    const departure = airport.entry?.departure;
    if (!departure) return [airport];
    const scope = { ...airport.scope, departure: airport };
    const procedure: RouteAtom = { text: departure.ident, source: airport.source, scope,
      owners: [], incomingOwners: [], departure };
    const next = atoms[index + 1];
    if (next?.text === departure.transition) return [airport, procedure];
    const exit: RouteAtom = { text: departure.transition, source: airport.source, scope, owners: [], incomingOwners: [] };
    return [airport, procedure, exit];
  });
}
