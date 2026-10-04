import type { GeoPointFeature, TerrainSource } from '@zlayer/contracts';
import type { Point, Segment } from '../../core/geo/route-corridor';
import type { GlideViewport } from './coverage';

export type GlideAirport = { id: string; coordinate: Point; elevationFt: number; feature: GeoPointFeature };
type GlideRangeStatus = 'loading' | 'ready' | 'outside' | 'partial' | 'zoom';
export type GlideStatus = {
  state: 'idle' | 'loading' | 'ready' | 'partial' | 'error' | 'zoom';
  point?: GlideRangeStatus | undefined;
  pointRouteNm?: number | undefined;
  ownship?: GlideRangeStatus | 'unavailable';
  route?: boolean;
  airports?: number;
};
export type GlideAreas = GeoJSON.FeatureCollection<GeoJSON.MultiPolygon>;
export type GlideLines = GeoJSON.FeatureCollection<GeoJSON.MultiLineString>;
/** A completed ownship or selected-origin calculation, including an empty or incomplete range.
 * A null result means this origin has not been calculated. */
export type GlideRange = { key: string; line: GlideLines; area: GlideAreas; incomplete: boolean };
export type GlideResult = {
  planRevision: number;
  areas: GlideAreas;
  airports: GeoPointFeature[];
  incomplete: boolean;
  ownship: GlideRange | null;
  point: GlideRange | null;
  pointRouteNm?: number;
  work: {
    terrainSourceCells: number;
    terrainCells: number;
    profileCells: number;
    profilesBuilt: number;
    profilesReused: number;
    planReused: boolean;
    footprintsReused: number;
  };
};
export type GlideRequest = {
  id: number;
  /** Airport plan accepted by both map sources in this worker session. */
  acceptedPlanKey?: string;
  /** Overview views may reconcile cached coverage, but must not acquire new origins. */
  discover?: boolean;
  airports: GlideAirport[];
  airportsEnabled?: boolean;
  altitude: number;
  ratio: number;
  viewport: GlideViewport;
  segments: Segment[];
  ownship: Point | null;
  point?: Point | null;
  /** A selected landing witness uses reverse arrival coverage instead of forward glide. */
  pointElevationFt?: number;
  sources: TerrainSource[];
  sourceKey: string;
  airportKey?: string;
  base: string;
  tileUrl: string;
};
export type GlideResponse = Omit<GlideResult, 'areas' | 'airports'> & {
  planKey: string;
  airportCount: number;
  plan?: Pick<GlideResult, 'areas' | 'airports'>;
};
export type GlideWorker = { calculate(request: GlideRequest): Promise<GlideResponse>; cancel(id: number): void };
export const emptyAreas = (): GlideAreas => ({ type: 'FeatureCollection', features: [] });
export const emptyLines = (): GlideLines => ({ type: 'FeatureCollection', features: [] });
