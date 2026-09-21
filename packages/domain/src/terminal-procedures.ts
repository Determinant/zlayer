import type { TerminalProcedure, TerminalProcedurePoint, TerminalProceduresData } from '@zlayer/contracts';
import { expansionOwner, expansionMessage, sourceIssue, type RouteAtom, type ExpandedRoutePoint, type PointRequirement } from './route-source.js';
import { departureBranches } from './departures.js';

export type ResolvedRouteProcedure = {
  tokenIndex: number;
  ident: string;
  kind: TerminalProcedure['kind'];
  airport: string;
  transition: string;
  points: TerminalProcedurePoint[];
  partial: boolean;
};

export type ProcedureRouteIssue = {
  tokenIndex: number;
  token: string;
  code: 'procedure-placement' | 'procedure-transition' | 'procedure-branch' | 'procedure-point-unavailable';
  message: string;
};

export function createProcedureExpander(data?: TerminalProceduresData) {
  const byIdent = new Map<string, TerminalProcedure[]>();
  for (const procedure of data?.procedures ?? []) {
    const entries = byIdent.get(procedure.ident) ?? [];
    entries.push(procedure);
    byIdent.set(procedure.ident, entries);
  }
  return (atoms: readonly RouteAtom[], source: readonly ExpandedRoutePoint[],
    airportAt: (atom: RouteAtom) => string | undefined) => {
    const points = source.map(point => ({ ...point, requirements: [...point.requirements], incoming: { ...point.incoming } }));
    const procedures: ResolvedRouteProcedure[] = [];
    const issues: ProcedureRouteIssue[] = [];
    for (let index = 0; index < points.length; index++) {
      const point = points[index]!;
      const atom = point.atom;
      if (!atom || atom.pinnedFeatureId || atom.blocked) continue;
      const selected = atom.departure;
      const records = byIdent.get(point.ident);
      if (!records && !selected) continue;
      const owner = expansionOwner('procedure', atom);
      const tokenIndex = atom.source.tokenIndex;
      const at = atoms.indexOf(atom);
      const { departure: origin, destination } = atom.scope;
      const departure = atoms[at - 1] === origin && !!origin && !!airportAt(origin);
      const arrival = atoms[at + 1] === destination && !!destination && !!airportAt(destination);
      const airportAtom = departure ? origin : destination;
      const airport = airportAtom && airportAt(airportAtom);
      const kind = departure ? 'departure' : 'arrival';
      const eligible = (records ?? []).filter(record => record.kind === kind && airport && record.airports.includes(airport) &&
        (!selected || selected.airportId === airport && selected.procedureId === record.id &&
          selected.effectiveDate === data?.metadata.effectiveDate));
      const report = (code: ProcedureRouteIssue['code'], message: string) =>
        issues.push(sourceIssue(atom.source, code, expansionMessage(owner, `${point.ident}: ${message}`)));
      const fail = (code: ProcedureRouteIssue['code'], message: string) => {
        report(code, message);
        if (points[index + 1]) points[index + 1]!.incoming.connected = false;
        points.splice(index--, 1);
      };
      if (selected && !eligible.length) {
        fail('procedure-branch', 'selected SID is unavailable for this airport in this data edition'); continue;
      }
      if ((!departure && !arrival) || !eligible.length) {
        fail('procedure-placement', 'must follow its departure airport or precede its arrival airport'); continue;
      }
      const neighbourAtom = atoms[at + (departure ? 1 : -1)];
      const neighbour = departure ? points[index + 1] : points[index - 1];
      if (!neighbour || !neighbourAtom || neighbour.atom !== neighbourAtom) {
        fail('procedure-transition', 'an explicit entry/exit fix is required next to the procedure'); continue;
      }
      const branch = selected?.branchId ? departureBranches(eligible[0]!, airport!).find(entry => entry.id === selected.branchId) : undefined;
      if (selected?.branchId && !branch) {
        fail('procedure-branch', 'selected runway/branch is unavailable in this data edition'); continue;
      }
      const paths = eligible.flatMap(record => pathsFor(record, airport!, neighbour.ident, branch?.route));
      if (!paths.length) { fail('procedure-transition', `no published ${departure ? 'exit' : 'entry'} at ${neighbour.ident} for ${airport}`); continue; }
      const common = sharedPath(paths, departure);
      const partial = paths.some(path => path.length !== common.length);
      if (!common.length) { fail('procedure-transition', 'the published branches have no unambiguous shared route'); continue; }
      const required = departure ? common.at(-1)! : common[0]!;
      const existing = neighbour.requirements.filter(requirement => requirement.owner.kind === 'procedure');
      if (existing.some(entry => entry.ident !== required.ident || entry.type !== required.type || entry.icaoRegion !== required.icaoRegion)) {
        fail('procedure-transition', 'the adjoining procedures require different identities for the shared fix'); continue;
      }
      procedures.push({ tokenIndex, ident: point.ident, kind, airport: airport!, transition: neighbour.ident, points: common, partial });
      if (partial) report('procedure-branch', 'runway/branch not selected; showing only the shared waypoint route');
      if (common.some((entry, i) => i > 0 && common[i - 1]!.next !== entry.ident)) {
        report('procedure-branch', 'a published route discontinuity is left open');
      }
      const owners = [...atom.owners, owner];
      const requirement = (entry: TerminalProcedurePoint): PointRequirement => ({ ident: entry.ident, type: entry.type,
        ...(entry.icaoRegion ? { icaoRegion: entry.icaoRegion } : {}), owner });
      const expanded = common.map((entry, i): ExpandedRoutePoint => ({ ident: entry.ident, source: atom.source,
        owners, requirements: [requirement(entry)],
        incoming: { connected: i > 0 && common[i - 1]!.next === entry.ident, owners } }));
      neighbour.requirements.push(requirement(required));
      if (departure) {
        neighbour.owners = [...neighbour.owners, owner];
        neighbour.incoming = expanded.at(-1)!.incoming;
        points.splice(index, 1, ...expanded.slice(0, -1));
        index += expanded.length - 2;
      } else {
        points.splice(index, 1, ...expanded.slice(1));
        index += expanded.length - 2;
        if (points[index + 1]) points[index + 1]!.incoming.connected = false;
      }
    }
    return { points, procedures, issues };
  };
}

function pathsFor(procedure: TerminalProcedure, airport: string, anchor: string,
  branch?: TerminalProcedure['routes'][number]): TerminalProcedurePoint[][] {
  const departure = procedure.kind === 'departure';
  const bodies = procedure.routes.filter(route => route.kind === 'body' && route.airports.some(entry => entry.ident === airport) &&
    (!branch || route === branch));
  const transitions = procedure.routes.filter(route => route.kind === 'transition' &&
    (departure ? route.points.at(-1) : route.points[0])?.ident === anchor);
  const paths: TerminalProcedurePoint[][] = [];
  for (const body of bodies) {
    body.points.forEach((point, anchorAt) => {
      if (point.ident === anchor) paths.push(departure ? body.points.slice(0, anchorAt + 1) : body.points.slice(anchorAt));
    });
    for (const transition of transitions) {
      const first = departure ? body.points : transition.points;
      const last = departure ? transition.points : body.points;
      if (samePoint(first.at(-1), last[0])) paths.push([...first.slice(0, -1), ...last]);
    }
  }
  return paths;
}

/** SIDs merge toward the exit; STARs diverge after the entry. Never pick a runway by array order. */
function sharedPath(paths: TerminalProcedurePoint[][], departure: boolean): TerminalProcedurePoint[] {
  const first = paths[0]!;
  let length = 0;
  const limit = Math.min(...paths.map(path => path.length));
  while (length < limit) {
    const at = (path: TerminalProcedurePoint[]) => departure ? path.length - 1 - length : length;
    if (!paths.every(path => samePoint(first[at(first)], path[at(path)]) &&
      // Compare edge topology too, except for the unconnected end of the preview.
      (length === 0 || (departure
        ? first[at(first)]!.next === path[at(path)]!.next
        : first[length - 1]!.next === path[length - 1]!.next)))) break;
    length++;
  }
  return departure ? first.slice(first.length - length) : first.slice(0, length);
}

function samePoint(a: TerminalProcedurePoint | undefined, b: TerminalProcedurePoint | undefined): boolean {
  return !!a && !!b && a.ident === b.ident && a.type === b.type && a.icaoRegion === b.icaoRegion;
}
