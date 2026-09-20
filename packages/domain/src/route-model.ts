import type { GeoPointFeature, NavigationLayerId, PointGeometry } from '@zlayer/contracts';
import type { AirwayRouteIssue, InferredAirwayTransition, ResolvedRouteAirway } from './airways.js';
import type { ProcedureRouteIssue, ResolvedRouteProcedure } from './terminal-procedures.js';
import type { TecRouteIssue, ResolvedTecRoute } from './tec-routes.js';
import type { RouteOwner, RouteSource } from './route-source.js';

export type RouteEntry = { readonly id: string; readonly text: string; readonly pinnedFeatureId?: string };
export type RouteDraft = { readonly entries: readonly RouteEntry[] };
export type RouteEditTarget =
  | { kind: 'waypoint'; entryId: string }
  | { kind: 'leg'; afterEntryId: string };
export type RouteWaypoint = {
  /** Display position only; edits use the stable entry ID. */
  tokenIndex?: number;
  source: RouteSource;
  owners: RouteOwner[];
  edit?: Extract<RouteEditTarget, { kind: 'waypoint' }>;
  ident: string;
  layer: NavigationLayerId;
  feature: GeoPointFeature;
};
export type RouteLeg = {
  owners: RouteOwner[];
  edit?: Extract<RouteEditTarget, { kind: 'leg' }>;
  from: RouteWaypoint;
  to: RouteWaypoint;
  midpoint: PointGeometry['coordinates'];
  distanceNm: number;
};
export type RouteIssue = AirwayRouteIssue | ProcedureRouteIssue | TecRouteIssue | {
  tokenIndex: number;
  token: string;
  code: 'waypoint-not-found' | 'airway-point-unavailable';
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
};
/** Import adapter for filing text and version-1 saved drafts. Never edited in place. */
export type RouteFeaturePins = Readonly<Partial<Record<number, string>>>;
export type RouteResolver = {
  (draft: RouteDraft): RoutePlan;
  (input: string, pinnedFeatureIds?: RouteFeaturePins): RoutePlan;
};
