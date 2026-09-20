import type { NavigationData, PreferredRouteRecord, PreferredRoutesData } from '@zlayer/contracts';
import { preferredRouteAirports, resolvePreferredRouteEntries } from './preferred-routes.js';
import { expansionOwner, sourceIssue, type RouteAtom, type RouteSegment } from './route-source.js';

export type TecRouteIssue = {
  tokenIndex: number;
  token: string;
  code: 'tec-placement' | 'tec-airports' | 'tec-ambiguous' | 'tec-route-unavailable';
  message: string;
};

export type ResolvedTecRoute = { tokenIndex: number; route: PreferredRouteRecord };
/** Build scoped children directly; no string expansion or plan remapping. */
export function createTecInterpreter(navigation: NavigationData, data?: PreferredRoutesData) {
  const byDesignator = new Map<string, PreferredRouteRecord[]>();
  for (const route of data?.routes ?? []) {
    if (route.routeType !== 'TEC' || !route.designator) continue;
    const records = byDesignator.get(route.designator) ?? [];
    records.push(route);
    byDesignator.set(route.designator, records);
  }
  return (atoms: RouteAtom[]) => {
    const issues: TecRouteIssue[] = [];
    const segments = new Map<RouteAtom, RouteSegment>();
    for (const [index, atom] of atoms.entries()) {
      const records = byDesignator.get(atom.text);
      if (!records || atom.pinnedFeatureId) continue;
      const fail = (code: TecRouteIssue['code'], message: string) => {
        atom.blocked = true;
        issues.push(sourceIssue(atom.source, code, `${atom.text}: ${message}`));
      };
      const origin = atoms[index - 1], destination = atoms[index + 1];
      if (!origin || !destination) {
        fail('tec-placement', 'place the TEC designator immediately between its departure and destination airports');
        continue;
      }
      const pair = preferredRouteAirports([origin.text, destination.text], navigation.airports?.features ?? [], {
        ...(origin.pinnedFeatureId ? { 0: origin.pinnedFeatureId } : {}),
        ...(destination.pinnedFeatureId ? { 1: destination.pinnedFeatureId } : {}),
      });
      if (!pair) { fail('tec-airports', 'the immediately preceding and following entries must resolve to unambiguous airports'); continue; }
      const matches = records.filter(route => route.originId === pair.origin.properties.faaId && route.destinationId === pair.destination.properties.faaId);
      if (!matches.length) { fail('tec-airports', 'not published for this airport pair and direction'); continue; }
      if (matches.length !== 1) { fail('tec-ambiguous', 'multiple published definitions match; no route was selected'); continue; }
      const route = matches[0]!;
      const entries = resolvePreferredRouteEntries(route, pair, navigation);
      if (!entries) { fail('tec-route-unavailable', 'the published route or a required typed waypoint is unavailable or ambiguous'); continue; }
      const owner = expansionOwner('tec', atom);
      const scope = { departure: origin, destination };
      const children = entries.slice(1, -1).map((entry): RouteAtom => ({
        text: entry.text, source: atom.source, scope, owners: [owner], incomingOwners: [owner],
        ...(entry.pinnedFeatureId ? { pinnedFeatureId: entry.pinnedFeatureId } : {}),
      }));
      if (pair.origin.id) origin.pinnedFeatureId = pair.origin.id;
      if (pair.destination.id) destination.pinnedFeatureId = pair.destination.id;
      destination.incomingOwners = [owner];
      segments.set(atom, { kind: 'tec', owner, origin, destination, children, route });
    }
    const nodes = atoms.map(atom => segments.get(atom) ?? atom);
    return { nodes, atoms: nodes.flatMap(node => 'children' in node ? node.children : [node]), issues,
      routes: [...segments.values()].map(segment => ({ tokenIndex: segment.owner.source.tokenIndex, route: segment.route })) };
  };
}
