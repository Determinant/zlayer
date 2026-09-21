import type { PreferredRouteRecord } from '@zlayer/contracts';
import type { RouteEntry } from './route-model.js';

/** The user's entry remains the source even inside nested published expansions. */
export type RouteSource = { entryId: string; tokenIndex: number; token: string };
export type RouteOwner = { kind: 'airway' | 'procedure' | 'tec' | 'approach'; source: RouteSource; ident: string };
export type RouteScope = { departure?: RouteAtom; destination?: RouteAtom };
export type RouteAtom = {
  text: string;
  source: RouteSource;
  entry?: RouteEntry;
  pinnedFeatureId?: string;
  scope: RouteScope;
  owners: RouteOwner[];
  incomingOwners: RouteOwner[];
  blocked?: boolean;
};
export type RouteSegment = {
  kind: 'tec'; owner: RouteOwner; origin: RouteAtom; destination: RouteAtom;
  children: RouteAtom[]; route: PreferredRouteRecord;
};
export type PointRequirement = {
  ident: string;
  type?: string;
  icaoRegion?: string;
  owner: RouteOwner;
};
/** Shared input to feature resolution; an incoming edge can explicitly be absent. */
export type ExpandedRoutePoint = {
  ident: string;
  source: RouteSource;
  atom?: RouteAtom;
  owners: RouteOwner[];
  requirements: PointRequirement[];
  incoming: { connected: boolean; owners: RouteOwner[] };
};
export function routeAtoms(entries: readonly RouteEntry[]): RouteAtom[] {
  const scope: RouteScope = {};
  const atoms = entries.map((entry, tokenIndex): RouteAtom => ({ text: entry.text, entry,
    source: { entryId: entry.id, tokenIndex, token: entry.text }, scope, owners: [], incomingOwners: [],
    ...(entry.pinnedFeatureId ? { pinnedFeatureId: entry.pinnedFeatureId } : {}) }));
  if (atoms[0]) scope.departure = atoms[0];
  if (atoms.at(-1)) scope.destination = atoms.at(-1)!;
  return atoms;
}
export function pointFromAtom(atom: RouteAtom, connected: boolean): ExpandedRoutePoint {
  return { ident: atom.text, source: atom.source, atom, owners: atom.owners, requirements: [],
    incoming: { connected, owners: atom.incomingOwners } };
}
export function expansionOwner(kind: RouteOwner['kind'], atom: RouteAtom): RouteOwner {
  return { kind, source: atom.source, ident: atom.text };
}
export function sourceIssue<T extends string>(source: RouteSource, code: T, message: string) {
  return { tokenIndex: source.tokenIndex, token: source.token, code, message };
}
export function expansionMessage(owner: RouteOwner, message: string): string {
  return owner.source.token === owner.ident ? message : `${owner.source.token}: ${message}`;
}
