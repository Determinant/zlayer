import type { GeoPointFeature, NavigationLayerId, PointGeometry } from '@zlayer/contracts';
import type { AirwayRouteIssue, InferredAirwayTransition, ResolvedRouteAirway } from './airways.js';
import type { ProcedureRouteIssue, ResolvedRouteProcedure } from './terminal-procedures.js';
import type { TecRouteIssue, ResolvedTecRoute } from './tec-routes.js';
import type { RouteOwner, RouteSource } from './route-source.js';

/** Chart identity and an explicit published entry, pinned to the coded data edition. */
export type RouteApproach = {
  readonly kind: 'approach';
  readonly source: 'chart' | 'cifp';
  readonly airportId: string;
  readonly procedureId: string;
  readonly name: string;
  readonly cycle: string;
  readonly entry?: {
    readonly routeId: string;
    readonly transitionId: string;
    readonly name: string;
    readonly effectiveDate: string;
  };
};
export type RouteEntry = {
  readonly id: string;
  readonly text: string;
  readonly pinnedFeatureId?: string;
  readonly approach?: RouteApproach;
  readonly departure?: RouteDeparture;
  readonly arrival?: RouteArrival;
};
/** A SID belongs to its airport occurrence. Imported filing text can lack a branch. */
type TerminalSelectionFields = {
  readonly airportId: string;
  readonly procedureId: string;
  readonly ident: string;
  readonly name: string;
  readonly effectiveDate: string;
  readonly transition: string;
  readonly branchId?: string;
  readonly branchName?: string;
};
export type RouteTerminal = TerminalSelectionFields & ({ readonly kind: 'departure' } | { readonly kind: 'arrival' }) & (
  { readonly source: 'nasr'; readonly codedBranches?: never; readonly codedRunway?: never } |
  { readonly source: 'cifp'; readonly branchId: string; readonly codedBranches: readonly string[]; readonly codedRunway?: string }
);
export type RouteDeparture = Extract<RouteTerminal, { kind: 'departure' }>;
export type RouteArrival = Extract<RouteTerminal, { kind: 'arrival' }>;
/** Source and kind establish capabilities. Persistence adapts legacy shapes once. */
export type TerminalSelection = RouteApproach | RouteTerminal;
export type RouteDraft = { readonly entries: readonly RouteEntry[] };
export type RouteEditTarget =
  | { kind: 'waypoint'; entryId: string }
  | { kind: 'leg'; afterEntryId: string };
export type ApproachArrival = {
  coordinate: PointGeometry['coordinates'];
  /** Arrival course at this point, when it coincides with the selected entry fix. */
  course?: number;
};
export type RouteWaypoint = {
  /** Display position only; edits use the stable entry ID. */
  tokenIndex?: number;
  source: RouteSource;
  owners: RouteOwner[];
  edit?: Extract<RouteEditTarget, { kind: 'waypoint' }>;
  ident: string;
  layer: NavigationLayerId;
  feature: GeoPointFeature;
  /** Original connected arrival, retained when VTF or a coincident entry removes its connector. */
  approachArrival?: ApproachArrival;
  approachRole?: string;
  approachPhase?: 'approach' | 'missed';
  /** The landing path reaches this endpoint without an unresolved tail. */
  approachLandingEnd?: true;
  approachHold?: {
    turn: 'L' | 'R' | 'unknown';
    inboundCourse?: number;
    arrivalCourse?: number;
    length?: string;
    missedEnd: boolean;
    entry?: 'Direct' | 'Parallel' | 'Teardrop';
  };
  procedureConstraint?: string;
  /** A coded STAR ends at this fixed point; absent for an open vector ending. */
  arrivalEnd?: true;
};
export type RouteLeg = {
  owners: RouteOwner[];
  edit?: Extract<RouteEditTarget, { kind: 'leg' }>;
  from: RouteWaypoint;
  to: RouteWaypoint;
  midpoint: PointGeometry['coordinates'];
  distanceNm: number;
  approachPhase?: 'approach' | 'missed';
  geometry?: PointGeometry['coordinates'][];
};
export type RouteIssue = AirwayRouteIssue | ProcedureRouteIssue | TecRouteIssue | {
  tokenIndex: number;
  token: string;
  code: 'waypoint-not-found' | 'airway-point-unavailable' | 'approach-unavailable' | 'approach-discontinuity';
  message: string;
};
export type RoutePlan = {
  revision: number;
  entries: readonly RouteEntry[];
  tokens: string[];
  waypoints: RouteWaypoint[];
  legs: RouteLeg[];
  airways: ResolvedRouteAirway[];
  procedures: ResolvedRouteProcedure[];
  tecRoutes: ResolvedTecRoute[];
  transitions: InferredAirwayTransition[];
  issues: RouteIssue[];
  unresolved: string[];
  distanceNm: number;
  approachExtensions?: PointGeometry['coordinates'][][];
  /** Connect known points across unresolved paths for map and terrain coverage only. */
  planningConnections?: { from: RouteWaypoint; to: RouteWaypoint;
    /** Continue from a known maneuver's open end instead of bypassing it. */
    start?: PointGeometry['coordinates'] }[];
  /** Planning symbols: included in terrain coverage, excluded from route distance. */
  approachDepictions?: ApproachDepiction[];
  /** Source-preserving terminal geometry, including schematic spans and open gaps. */
  terminalPaths?: { kind: 'departure' | 'arrival' | 'approach'; owner: RouteOwner;
    spans: import('./approach-path.js').ApproachSpan[]; issues: import('./approach-path.js').ApproachPathIssue[];
    policy: import('./approach-path.js').ApproachPreview['policy'] }[];
};
export type ApproachDepiction = {
  kind: 'hold' | 'missed' | 'intercept' | 'procedure-turn';
  phase: 'approach' | 'missed';
  coordinates: PointGeometry['coordinates'][];
  arrow?: { coordinate: PointGeometry['coordinates']; bearing: number };
};
/** Import adapter for filing text and version-1 saved drafts. Never edited in place. */
export type RouteFeaturePins = Readonly<Partial<Record<number, string>>>;
export type RouteResolver = {
  (draft: RouteDraft): RoutePlan;
  (input: string, pinnedFeatureIds?: RouteFeaturePins): RoutePlan;
};
