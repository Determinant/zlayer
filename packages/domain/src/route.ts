import type {
  AirwayDataResponse,
  ApproachFix,
  FeatureCollectionResponse,
  GeoPointFeature,
  NavigationLayerId,
  PointGeometry,
  TerminalProceduresData,
  PreferredRoutesData,
} from '@zlayer/contracts';
import { createProcedureExpander } from './terminal-procedures.js';
import { departureAtoms } from './departures.js';
import { codedTerminalAtoms } from './coded-terminals.js';
import { createTecInterpreter } from './tec-routes.js';
import { approachFixFeature } from './approaches.js';
import { composeTerminals } from './terminal-composition.js';
import { terminalIndex } from './terminal-index.js';
import { TERMINAL_FIX_TOLERANCE_NM } from './terminal-fixes.js';

import type { RouteDraft, RouteFeaturePins, RoutePlan, RouteResolver, RouteWaypoint } from './route-model.js';
import { normalizeRouteToken, routeTokenForFeature } from './route-text.js';
import { parseRouteCoordinate } from './route-coordinate.js';
import { featureIdentifiers } from './features.js';
import {
  createAirwayChainResolver,
  expandAirwayRoute,
} from './airways.js';

import { routeEntriesFromText } from './route-draft.js';
import { routeAtoms, expansionMessage, sourceIssue, type PointRequirement, type RouteOwner } from './route-source.js';

let planRevision = 0;

type Candidate = {
  layer: NavigationLayerId;
  feature: GeoPointFeature;
};

const EARTH_RADIUS_NM = 3_440.065;
const LAYER_PRIORITY: Record<NavigationLayerId, number> = {
  airports: 0,
  navaids: 1,
  'vfr-waypoints': 2,
  fixes: 3,
};

export function createRouteResolver(
  collections: readonly FeatureCollectionResponse[],
  airwayData?: AirwayDataResponse,
  terminalData?: TerminalProceduresData,
  preferredData?: PreferredRoutesData,
): RouteResolver {
  const indexes = buildIndexes(collections);
  const resolveApproachFix = (fix: ApproachFix): Candidate | undefined => {
    // A shared name alone is insufficient: runway names and navigation homonyms
    // can refer to different places. Allow only a small reference-rounding gap.
    const matches = indexes.byIdentifier.get(normalizeRouteToken(fix.ident))?.filter(candidate =>
      (candidate.layer === 'fixes' || candidate.layer === 'navaids') &&
      routeTokenForFeature(candidate.feature) === normalizeRouteToken(fix.ident) &&
      candidate.feature.properties.type?.trim().toUpperCase() !== 'VOT' &&
      distanceNm(candidate.feature.geometry.coordinates, fix.coordinate) < TERMINAL_FIX_TOLERANCE_NM);
    return matches?.length === 1 ? matches[0] : undefined;
  };
  const terminal = terminalData ? terminalIndex(terminalData) : undefined;
  const resolvePin = (id: string | undefined, fix?: ApproachFix): Candidate | undefined => {
    if (!id) return;
    const existing = indexes.byFeatureId.get(id);
    if (existing) return existing;
    fix ??= terminal?.fix(id);
    if (!fix) return;
    const candidate = resolveApproachFix(fix) ?? { layer: 'fixes', feature: approachFixFeature(fix) };
    indexes.byFeatureId.set(id, candidate);
    return candidate;
  };
  const resolveAirwayChain = createAirwayChainResolver(airwayData);
  const expandProcedures = createProcedureExpander(terminalData);
  const interpretTec = createTecInterpreter(Object.fromEntries(collections.map(collection => [collection.meta.layer, collection])), preferredData);
  const airwayIdentifiers = new Set(airwayData?.airways
    .filter(airway => airway.regulatory !== false).map(airway => normalizeRouteToken(airway.ident)));
  return (input: string | RouteDraft, pinnedFeatureIds?: RouteFeaturePins) => {
    const draft = typeof input === 'string'
      ? { entries: routeEntriesFromText(input, pinnedFeatureIds, index => `token:${index}`) } : input;
    const plan = emptyRoutePlan(draft);
    const tec = interpretTec(routeAtoms(draft.entries));
    const atoms = codedTerminalAtoms(departureAtoms(tec.atoms), terminalData, atom => {
      const pinned = resolvePin(atom.pinnedFeatureId, atom.terminalFix);
      const candidate = selectCandidate(atom.pinnedFeatureId ? pinned ? [pinned] : [] : indexes.byIdentifier.get(atom.text), atom.text);
      return candidate?.layer === 'airports' ? [candidate.feature.properties.icaoId, candidate.feature.properties.faaId, atom.text] : [];
    });
    const expansion = expandAirwayRoute(atoms, resolveAirwayChain, (token, index) =>
      !!atoms[index]!.pinnedFeatureId || !!parseRouteCoordinate(token) || (indexes.byIdentifier.has(token) &&
        (index === 0 || index === atoms.length - 1 || !airwayIdentifiers.has(token))));
    const terminal = expandProcedures(atoms, expansion.points, atom => {
      const pinned = resolvePin(atom.pinnedFeatureId, atom.terminalFix);
      const candidates = atom.pinnedFeatureId ? pinned ? [pinned] : [] : indexes.byIdentifier.get(atom.text);
      const candidate = selectCandidate(candidates, atom.text);
      const airport = candidate?.layer === 'airports' ? candidate.feature : undefined;
      return typeof airport?.properties.faaId === 'string' ? airport.properties.faaId : undefined;
    });
    plan.airways = expansion.airways;
    plan.procedures = terminal.procedures;
    plan.tecRoutes = tec.routes;
    plan.transitions = expansion.transitions;
    plan.issues = [...tec.issues, ...expansion.issues, ...terminal.issues];
    const reported = new Set<RouteOwner>();
    let previous: RouteWaypoint | undefined;
    for (const point of terminal.points) {
      if (point.atom?.blocked) { previous = undefined; continue; }
      const pin = point.atom?.pinnedFeatureId;
      const pinned = resolvePin(pin, point.atom?.terminalFix);
      const candidates = pin ? pinned ? [pinned] : [] : indexes.byIdentifier.get(point.ident);
      const eligible = candidates?.filter(candidate => point.requirements.every(required => matchesRequirement(candidate, required)));
      const coordinate = !pin && point.atom?.entry && point.requirements.length === 0
        ? parseRouteCoordinate(point.ident) : undefined;
      const candidate = coordinate ? { layer: 'fixes' as const, feature: coordinate }
        : selectCandidate(eligible, point.ident, previous?.feature);
      if (!candidate) {
        const requirement = point.requirements.find(required => required.owner.kind === 'procedure') ??
          (!point.atom?.entry ? point.requirements.find(required => required.owner.kind === 'airway') : undefined);
        if (requirement) {
          const { owner } = requirement;
          const code = owner.kind === 'procedure' ? 'procedure-point-unavailable' : 'airway-point-unavailable';
          if (!reported.has(owner)) {
            reported.add(owner);
            plan.issues.push(sourceIssue(owner.source, code, expansionMessage(owner,
              `${owner.ident}: required point ${point.ident} is unavailable in the loaded navigation data`)));
          }
        } else {
          plan.issues.push(sourceIssue(point.source, 'waypoint-not-found',
            pin ? `${point.source.token}: the selected waypoint is unavailable or incompatible with this route`
              : point.requirements.length ? `${point.source.token}: the required published waypoint is unavailable`
              : `${point.source.token} is not a known waypoint`));
        }
        previous = undefined;
        continue;
      }
      const entry = point.atom?.entry;
      const waypoint: RouteWaypoint = { source: point.source, owners: point.owners,
        ...(entry ? { tokenIndex: point.source.tokenIndex, edit: { kind: 'waypoint', entryId: entry.id } as const } : {}),
        ident: routeTokenForFeature(candidate.feature), layer: candidate.layer, feature: candidate.feature };
      plan.waypoints.push(waypoint);
      if (previous && point.incoming.connected) {
        const from = previous.feature.geometry.coordinates, to = waypoint.feature.geometry.coordinates;
        const afterEntryId = previous.edit?.entryId ?? (plan.entries[previous.source.tokenIndex]?.departure ? previous.source.entryId : undefined);
        const editable = point.incoming.owners.length === 0 && afterEntryId && waypoint.edit &&
          point.source.tokenIndex === previous.source.tokenIndex + 1;
        plan.legs.push({ owners: point.incoming.owners,
          ...(editable ? { edit: { kind: 'leg', afterEntryId } as const } : {}),
          from: previous, to: waypoint, midpoint: geographicMidpoint(from, to), distanceNm: distanceNm(from, to) });
      }
      previous = waypoint;
    }
    composeTerminals(plan, terminalData, resolveApproachFix);
    const order = new Map(plan.waypoints.map((point, index) => [point, index]));
    plan.legs.sort((a, b) => order.get(a.from)! - order.get(b.from)!);
    plan.issues.sort((a, b) => a.tokenIndex - b.tokenIndex);
    plan.unresolved = [...new Set(plan.issues.map(issue => issue.token))];
    plan.distanceNm = plan.legs.reduce((total, leg) => total + leg.distanceNm, 0);
    return plan;
  };
}

export function emptyRoutePlan(input: string | RouteDraft = ''): RoutePlan {
  const entries = typeof input === 'string' ? routeEntriesFromText(input, {}, index => `token:${index}`) : input.entries;
  return { revision: ++planRevision, entries, tokens: entries.map(entry => entry.text), waypoints: [], legs: [],
    airways: [], procedures: [], tecRoutes: [], transitions: [], issues: [], unresolved: [], distanceNm: 0 };
}

export function distanceNm(
  from: PointGeometry['coordinates'],
  to: PointGeometry['coordinates'],
): number {
  const latitude1 = degreesToRadians(from[1]);
  const latitude2 = degreesToRadians(to[1]);
  const latitudeDelta = latitude2 - latitude1;
  const longitudeDelta = degreesToRadians(to[0] - from[0]);
  const haversine = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

type CollectionIndexes = {
  byIdentifier: Map<string, Candidate[]>;
  byFeatureId: Map<string, Candidate>;
};

const collectionIndexes = new WeakMap<FeatureCollectionResponse, CollectionIndexes>();
function collectionIndex(collection: FeatureCollectionResponse): CollectionIndexes {
  const prepared = collectionIndexes.get(collection);
  if (prepared) return prepared;
  const byIdentifier = new Map<string, Candidate[]>();
  const byFeatureId = new Map<string, Candidate>();
  for (const feature of collection.features) {
    const candidate = { layer: collection.meta.layer, feature };
    if (feature.id) byFeatureId.set(feature.id, candidate);
    for (const identifier of featureIdentifiers(feature)) {
      const candidates = byIdentifier.get(identifier) ?? [];
      candidates.push(candidate);
      byIdentifier.set(identifier, candidates);
    }
  }
  for (const candidates of byIdentifier.values()) candidates.sort(compareCandidates);
  const result = { byIdentifier, byFeatureId };
  collectionIndexes.set(collection, result);
  return result;
}

/** A resolver keeps only its selected synthetic pins; national navigation
 * indexes are shared by immutable collection identity across route and pickers. */
function buildIndexes(collections: readonly FeatureCollectionResponse[]) {
  const sources = collections.map(collectionIndex), reversed = [...sources].reverse();
  const pins = new Map<string, Candidate>();
  return {
    byIdentifier: {
      has: (id: string) => sources.some(source => source.byIdentifier.has(id)),
      get: (id: string) => sources.flatMap(source => source.byIdentifier.get(id) ?? []).sort(compareCandidates),
    },
    byFeatureId: {
      get: (id: string) => pins.get(id) ?? reversed.find(source => source.byFeatureId.has(id))?.byFeatureId.get(id),
      set: (id: string, value: Candidate) => pins.set(id, value),
    },
  };
}

function selectCandidate(candidates: readonly Candidate[] | undefined, identifier: string, previous?: GeoPointFeature): Candidate | undefined {
  if (!candidates?.length) return undefined;
  // SFO names the navigation aid; KSFO names the airport. An airport's short
  // alias remains usable when no primary identifier matches, regardless of proximity.
  const exact = candidates.filter(candidate => routeTokenForFeature(candidate.feature) === identifier);
  const preferred = exact.length ? exact : candidates;
  // Some VORs share their identifier with a nearby VOR test transmitter.
  const navigation = preferred.filter(candidate => candidate.layer !== 'navaids' ||
    candidate.feature.properties.type?.trim().toUpperCase() !== 'VOT');
  const matches = navigation.length ? navigation : preferred;
  if (!previous || matches.length === 1) return matches[0];
  const origin = previous.geometry.coordinates;
  return matches.reduce((nearest, candidate) => distanceNm(origin, candidate.feature.geometry.coordinates) <
    distanceNm(origin, nearest.feature.geometry.coordinates) ? candidate : nearest);
}

function matchesRequirement(candidate: Candidate, required: PointRequirement): boolean {
  if (!featureIdentifiers(candidate.feature).includes(required.ident)) return false;
  if (required.type) {
    const type = normalizeRouteToken(required.type);
    if (/(?:VOR|TACAN|NDB|DME)/.test(type) && candidate.layer !== 'navaids') return false;
    if (/^(?:RP|WP|CN)$/.test(type) && candidate.layer !== 'fixes') return false;
    const { properties } = candidate.feature;
    const types = [properties.type, properties.facilityType, properties.useCode]
      .filter((value): value is string => typeof value === 'string').map(normalizeRouteToken);
    if (!types.includes(type)) return false;
  }
  // NASR NAVAID region codes differ between products; procedure fixes use the region.
  return !required.icaoRegion || candidate.layer === 'navaids' || candidate.feature.properties.icaoRegion === required.icaoRegion;
}

function compareCandidates(left: Candidate, right: Candidate): number {
  return LAYER_PRIORITY[left.layer] - LAYER_PRIORITY[right.layer] ||
    routeTokenForFeature(left.feature).localeCompare(routeTokenForFeature(right.feature)) ||
    candidateSortKey(left.feature).localeCompare(candidateSortKey(right.feature));
}

// Resolution order is a route policy: changing key serialization must not pick
// a different point when several ID-less candidates have the same identifier.
function candidateSortKey(feature: GeoPointFeature): string {
  return feature.id ?? feature.geometry.coordinates.join(',');
}

export function geographicMidpoint(
  from: PointGeometry['coordinates'],
  to: PointGeometry['coordinates'],
): PointGeometry['coordinates'] {
  const latitude1 = degreesToRadians(from[1]);
  const longitude1 = degreesToRadians(from[0]);
  const latitude2 = degreesToRadians(to[1]);
  const longitudeDelta = degreesToRadians(to[0] - from[0]);
  const x = Math.cos(latitude2) * Math.cos(longitudeDelta);
  const y = Math.cos(latitude2) * Math.sin(longitudeDelta);
  const latitude = Math.atan2(
    Math.sin(latitude1) + Math.sin(latitude2),
    Math.sqrt((Math.cos(latitude1) + x) ** 2 + y ** 2),
  );
  const longitude = longitude1 + Math.atan2(y, Math.cos(latitude1) + x);
  return [normalizeLongitude(radiansToDegrees(longitude)), radiansToDegrees(latitude)];
}

function normalizeLongitude(longitude: number): number {
  return ((longitude + 540) % 360) - 180;
}

function degreesToRadians(value: number): number {
  return value * Math.PI / 180;
}

function radiansToDegrees(value: number): number {
  return value * 180 / Math.PI;
}
