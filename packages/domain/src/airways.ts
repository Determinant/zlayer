import type {
  AirwayDataResponse,
  AirwayRecord,
  AirwaySegment,
} from '@zlayer/contracts';

import { routeAtoms, pointFromAtom, expansionOwner, expansionMessage, sourceIssue, type RouteAtom, type ExpandedRoutePoint, type RouteOwner } from './route-source.js';

export type AirwayPathPoint = {
  ident: string;
  type?: string;
};

export type AirwayPath = {
  airwayId: string;
  ident: string;
  direction: 'forward' | 'reverse';
  points: AirwayPathPoint[];
  distanceNm?: number;
};

export type AirwayPathFailure =
  | 'unavailable'
  | 'not-found'
  | 'no-path'
  | 'ambiguous';

export type AirwayPathResult =
  | { ok: true; path: AirwayPath }
  | { ok: false; reason: AirwayPathFailure };

export type AirwayPathResolver = (
  airwayIdent: string,
  entryIdent: string,
  exitIdent: string,
) => AirwayPathResult;

export type AirwayChainPath = {
  paths: AirwayPath[];
};

export type AirwayChainResult =
  | { ok: true; chain: AirwayChainPath }
  | { ok: false; reason: AirwayPathFailure };

export type AirwayChainResolver = (
  airwayIdents: readonly string[],
  entryIdent: string,
  exitIdent: string,
) => AirwayChainResult;

export type ResolvedRouteAirway = {
  tokenIndex: number;
  ident: string;
  airwayId: string;
  entry: string;
  exit: string;
  direction: AirwayPath['direction'];
  points: AirwayPathPoint[];
};

export type InferredAirwayTransition = {
  ident: string;
  beforeAirwayTokenIndex: number;
  afterAirwayTokenIndex: number;
};

export type AirwayRouteIssue = {
  tokenIndex: number;
  token: string;
  code: 'airway-placement' | `airway-${AirwayPathFailure}`;
  message: string;
};

export type AirwayRouteExpansion = {
  points: ExpandedRoutePoint[];
  airways: ResolvedRouteAirway[];
  transitions: InferredAirwayTransition[];
  issues: AirwayRouteIssue[];
};

type IndexedAirway = {
  record: AirwayRecord;
  pointIndexes: Map<string, number>;
  pointTypes: Map<string, string>;
  segments: Map<string, AirwaySegment>;
};

type ChainState = {
  record: IndexedAirway;
  entry: string;
  completedPaths: AirwayPath[];
};

const AIRWAY_IDENT = /^[VT]\d{1,4}$/;
const MAX_CHAIN_STATES = 2_048;
const PUBLISHED_DISTANCE_RESOLUTION_NM = 0.1;

export function isAirwayIdentifier(value: string): boolean {
  return AIRWAY_IDENT.test(normalizeIdentifier(value));
}

export function createAirwayPathResolver(
  data?: AirwayDataResponse,
): AirwayPathResolver {
  const resolveChain = createAirwayChainResolver(data);
  return (airwayIdent, entryIdent, exitIdent) => {
    const result = resolveChain([airwayIdent], entryIdent, exitIdent);
    if (!result.ok) return result;
    return { ok: true, path: result.chain.paths[0]! };
  };
}

export function createAirwayChainResolver(
  data?: AirwayDataResponse,
): AirwayChainResolver {
  if (!data) return () => ({ ok: false, reason: 'unavailable' });

  const byIdentifier = new Map<string, IndexedAirway[]>();
  for (const record of data.airways) {
    const ident = normalizeIdentifier(record.ident);
    if (!isAirwayIdentifier(ident) || record.regulatory === false) continue;
    const records = byIdentifier.get(ident) ?? [];
    records.push({
      record,
      pointIndexes: new Map(
        record.points.map((point, index) => [normalizeIdentifier(point), index]),
      ),
      pointTypes: pointTypesFor(record),
      segments: new Map(record.segments.flatMap(segment => segment.to
        ? [[segmentKey(segment.from, segment.to), segment]] : [])),
    });
    byIdentifier.set(ident, records);
  }
  for (const records of byIdentifier.values()) {
    records.sort((left, right) => left.record.id.localeCompare(right.record.id));
  }

  return (rawAirwayIdents, rawEntryIdent, rawExitIdent) => {
    const airwayIdents = rawAirwayIdents.map(normalizeIdentifier);
    const entryIdent = normalizeIdentifier(rawEntryIdent);
    const exitIdent = normalizeIdentifier(rawExitIdent);
    if (airwayIdents.length === 0 || entryIdent === exitIdent) {
      return { ok: false, reason: 'no-path' };
    }
    const recordGroups = airwayIdents.map((ident) => byIdentifier.get(ident) ?? []);
    if (recordGroups.some((records) => records.length === 0)) {
      return { ok: false, reason: 'not-found' };
    }

    let states: ChainState[] = recordGroups[0]!
      .filter((record) => record.pointIndexes.has(entryIdent))
      .map((record) => ({ record, entry: entryIdent, completedPaths: [] }));

    for (let airwayIndex = 0; airwayIndex < recordGroups.length - 1; airwayIndex += 1) {
      const nextRecords = recordGroups[airwayIndex + 1]!;
      const nextStates: ChainState[] = [];
      for (const state of states) {
        for (const nextRecord of nextRecords) {
          for (const transition of sharedPoints(state.record, nextRecord)) {
            const path = pathOnAirway(state.record, state.entry, transition);
            if (!path) continue;
            nextStates.push({
              record: nextRecord,
              entry: transition,
              completedPaths: [...state.completedPaths, path],
            });
            if (nextStates.length > MAX_CHAIN_STATES) {
              return { ok: false, reason: 'ambiguous' };
            }
          }
        }
      }
      states = nextStates;
      if (states.length === 0) return { ok: false, reason: 'no-path' };
    }

    const candidates = states.flatMap((state) => {
      const finalPath = pathOnAirway(state.record, state.entry, exitIdent);
      return finalPath ? [{ paths: [...state.completedPaths, finalPath] }] : [];
    });
    const componentCandidates = uniqueChains(candidates);
    if (componentCandidates.length === 0) return { ok: false, reason: 'no-path' };
    if (new Set(componentCandidates.map(componentKey)).size > 1) {
      return { ok: false, reason: 'ambiguous' };
    }
    const uniqueCandidates = collapseEquivalentGeometry(componentCandidates);
    if (
      uniqueCandidates.length > 1 &&
      uniqueCandidates.some((chain) => chain.paths.some((path) => path.distanceNm === undefined))
    ) {
      return { ok: false, reason: 'ambiguous' };
    }
    uniqueCandidates.sort(compareChains);
    const best = uniqueCandidates[0]!;
    const alternative = uniqueCandidates[1];
    if (alternative && compareChainCosts(best, alternative) === 0) {
      return { ok: false, reason: 'ambiguous' };
    }
    return { ok: true, chain: best };
  };
}

function pathOnAirway(
  indexed: IndexedAirway,
  entryIdent: string,
  exitIdent: string,
): AirwayPath | undefined {
  const entryIndex = indexed.pointIndexes.get(entryIdent);
  const exitIndex = indexed.pointIndexes.get(exitIdent);
  if (entryIndex === undefined || exitIndex === undefined || entryIndex === exitIndex) {
    return undefined;
  }
  const direction = entryIndex < exitIndex ? 'forward' : 'reverse';
  const start = Math.min(entryIndex, exitIndex);
  const end = Math.max(entryIndex, exitIndex);
  const identifiers = indexed.record.points
    .slice(start, end + 1)
    .map(normalizeIdentifier);
  if (direction === 'reverse') identifiers.reverse();
  const segments = identifiers.slice(0, -1).map((from, index) =>
    indexed.segments.get(segmentKey(from, identifiers[index + 1]!)));
  // Never infer connectivity from AIRWAY_STRING alone, including older exports
  // that omitted the FAA gap flag or an edge's segment record.
  if (segments.some(segment => !segment || segment.gap !== false)) return undefined;
  const distances = segments.map(segment => segment?.distanceNm);
  const hasCompleteDistance = distances.every(
    (distance): distance is number => distance !== undefined,
  );
  return {
    airwayId: indexed.record.id,
    ident: normalizeIdentifier(indexed.record.ident),
    direction,
    points: identifiers.map((ident) => ({
      ident,
      ...optionalPointType(indexed.pointTypes.get(ident)),
    })),
    ...(hasCompleteDistance
      ? { distanceNm: distances.reduce((sum, distance) => sum + distance, 0) }
      : {}),
  };
}

export function expandAirwayRoute(
  input: readonly string[] | readonly RouteAtom[],
  resolveChain: AirwayChainResolver,
  isExplicitWaypoint: (token: string, index: number) => boolean = () => false,
): AirwayRouteExpansion {
  const atoms = typeof input[0] === 'string'
    ? routeAtoms((input as readonly string[]).map((text, i) => ({ id: `token:${i}`, text: normalizeIdentifier(text) })))
    : input as readonly RouteAtom[];
  const isAirway = atoms.map((atom, index) => isAirwayIdentifier(atom.text) && !isExplicitWaypoint(atom.text, index));
  const points: ExpandedRoutePoint[] = [];
  const airways: ResolvedRouteAirway[] = [];
  const transitions: InferredAirwayTransition[] = [];
  const issues: AirwayRouteIssue[] = [];
  const explicitIndexes = atoms.flatMap((_atom, index) => isAirway[index] ? [] : [index]);
  const first = explicitIndexes[0], last = explicitIndexes.at(-1);
  atoms.forEach((atom, index) => {
    if (isAirway[index] && (first === undefined || last === undefined || index < first || index > last)) {
      const owner = expansionOwner('airway', atom);
      issues.push(sourceIssue(atom.source, 'airway-placement', expansionMessage(owner, `${atom.text} must be between a route entry and exit`)));
    }
  });
  let previousIndex: number | undefined;
  let previous: ExpandedRoutePoint | undefined;
  atoms.forEach((atom, index) => {
    if (isAirway[index]) return;
    const current = pointFromAtom(atom, previousIndex !== undefined && index === previousIndex + 1);
    if (previousIndex !== undefined && previous && index > previousIndex + 1) {
      const airwayAtoms = indexesBetween(previousIndex, index).map(i => atoms[i]!);
      const idents = airwayAtoms.map(atom => atom.text);
      const result = resolveChain(idents, previous.ident, current.ident);
      if (!result.ok) {
        for (const airway of airwayAtoms) {
          const issue = pathIssue(airway.source.tokenIndex, airway.text, idents.join(' → '), current.ident, previous.ident, result.reason);
          issues.push({ ...issue, token: airway.source.token, message: expansionMessage(expansionOwner('airway', airway), issue.message) });
        }
      } else {
        result.chain.paths.forEach((path, pathIndex) => {
          const airway = airwayAtoms[pathIndex]!;
          const owner = expansionOwner('airway', airway);
          const owners = [...airway.owners, owner];
          const start = pathIndex === 0 ? previous! : points.at(-1)!;
          requirePoint(start, path.points[0]!, owner);
          path.points.slice(1).forEach((entry, pointIndex) => {
            const final = pathIndex === result.chain.paths.length - 1 && pointIndex === path.points.length - 2;
            const point: ExpandedRoutePoint = final ? current : { ident: entry.ident, source: airway.source,
              owners, requirements: [], incoming: { connected: true, owners } };
            requirePoint(point, entry, owner);
            if (final) point.owners = [...point.owners, owner];
            point.incoming = { connected: true, owners };
            if (!final) points.push(point);
          });
          airways.push({ tokenIndex: airway.source.tokenIndex, ident: path.ident, airwayId: path.airwayId,
            entry: path.points[0]!.ident, exit: path.points.at(-1)!.ident, direction: path.direction, points: path.points });
          if (pathIndex < result.chain.paths.length - 1) transitions.push({ ident: path.points.at(-1)!.ident,
            beforeAirwayTokenIndex: airway.source.tokenIndex, afterAirwayTokenIndex: airwayAtoms[pathIndex + 1]!.source.tokenIndex });
        });
      }
    }
    points.push(current);
    previousIndex = index;
    previous = current;
  });
  issues.sort((a, b) => a.tokenIndex - b.tokenIndex);
  return { points, airways, transitions, issues };
}

function requirePoint(point: ExpandedRoutePoint, required: AirwayPathPoint, owner: RouteOwner): void {
  point.requirements.push({ ident: required.ident, ...(required.type ? { type: required.type } : {}), owner });
}

function sharedPoints(left: IndexedAirway, right: IndexedAirway): string[] {
  return left.record.points
    .map(normalizeIdentifier)
    .filter((point) => right.pointIndexes.has(point));
}

function segmentKey(left: string, right: string): string {
  return [normalizeIdentifier(left), normalizeIdentifier(right)].sort().join('\u0000');
}

function uniqueChains(chains: AirwayChainPath[]): AirwayChainPath[] {
  return [...new Map(chains.map((chain) => [chainKey(chain), chain])).values()];
}

function collapseEquivalentGeometry(chains: AirwayChainPath[]): AirwayChainPath[] {
  const byGeometry = new Map<string, AirwayChainPath>();
  for (const chain of chains) {
    const key = chainGeometryKey(chain);
    const existing = byGeometry.get(key);
    if (!existing || compareTransitionPlacement(chain, existing) < 0) {
      byGeometry.set(key, chain);
    }
  }
  return [...byGeometry.values()];
}

function chainGeometryKey(chain: AirwayChainPath): string {
  return chain.paths.flatMap((path, index) =>
    (index === 0 ? path.points : path.points.slice(1)).map((point) => point.ident)
  ).join(',');
}

function compareTransitionPlacement(left: AirwayChainPath, right: AirwayChainPath): number {
  for (let index = 0; index < left.paths.length - 1; index += 1) {
    const legDifference = left.paths[index]!.points.length - right.paths[index]!.points.length;
    if (legDifference !== 0) return legDifference;
  }
  return chainKey(left).localeCompare(chainKey(right));
}

function chainKey(chain: AirwayChainPath): string {
  return chain.paths.map((path) =>
    `${path.airwayId}:${path.points.map((point) => point.ident).join(',')}`
  ).join('|');
}

function componentKey(chain: AirwayChainPath): string {
  return chain.paths.map((path) => path.airwayId).join('|');
}

function compareChains(left: AirwayChainPath, right: AirwayChainPath): number {
  return compareChainCosts(left, right) ||
    chainKey(left).localeCompare(chainKey(right));
}

function compareChainCosts(left: AirwayChainPath, right: AirwayChainPath): number {
  return publishedDistanceUnits(left) - publishedDistanceUnits(right);
}

function publishedDistanceUnits(chain: AirwayChainPath): number {
  const distanceNm = chain.paths.reduce((sum, path) => sum + (path.distanceNm ?? 0), 0);
  return Math.round(distanceNm / PUBLISHED_DISTANCE_RESOLUTION_NM);
}

function indexesBetween(start: number, end: number): number[] {
  return Array.from({ length: Math.max(0, end - start - 1) }, (_, index) => start + index + 1);
}

function pointTypesFor(record: AirwayRecord): Map<string, string> {
  const result = new Map<string, string>();
  for (const segment of record.segments) {
    if (segment.fromType) result.set(normalizeIdentifier(segment.from), segment.fromType);
  }
  return result;
}

function optionalPointType(type: string | undefined): { type?: string } {
  return type ? { type } : {};
}

function pathIssue(
  tokenIndex: number,
  token: string,
  description: string,
  exit: string,
  entry: string,
  reason: AirwayPathFailure,
): AirwayRouteIssue {
  const detail = reason === 'unavailable'
    ? 'airway data is unavailable'
    : reason === 'not-found'
      ? `${description} contains an airway not published in this FAA cycle`
      : reason === 'ambiguous'
        ? `${description} has ambiguous routing from ${entry} to ${exit}`
        : `${description} does not connect ${entry} to ${exit}`;
  return {
    tokenIndex,
    token,
    code: `airway-${reason}`,
    message: detail,
  };
}

function normalizeIdentifier(value: string): string {
  return value.trim().toUpperCase();
}
