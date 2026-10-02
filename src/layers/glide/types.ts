import type { GeoPointFeature, TerrainSource } from '@zlayer/contracts';
import type { Point, Segment } from '../../core/geo/route-corridor';
import type { GlideViewport } from './coverage';

export type GlideAirport = { id: string; coordinate: Point; elevationFt: number; feature: GeoPointFeature };
export type GlideStatus = {
  state: 'idle' | 'loading' | 'ready' | 'partial' | 'error' | 'zoom';
  point?: 'loading' | 'ready' | 'outside' | 'partial' | undefined;
  ownship?: 'loading' | 'ready' | 'outside' | 'unavailable' | 'partial';
  route?: boolean;
  airports?: number;
};
export type GlideAreas = GeoJSON.FeatureCollection<GeoJSON.MultiPolygon>;
export type GlideLines = GeoJSON.FeatureCollection<GeoJSON.MultiLineString>;
export type GlideResult = {
  planRevision: number;
  areas: GlideAreas;
  airports: GeoPointFeature[];
  incomplete: boolean;
  ownship: GlideLines;
  ownshipArea: GlideAreas;
  ownshipIncomplete: boolean;
  ownshipCalculated: boolean;
  point: GlideLines;
  pointArea: GlideAreas;
  pointIncomplete: boolean;
  pointCalculated: boolean;
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
  airports: GlideAirport[];
  altitude: number;
  ratio: number;
  viewport: GlideViewport;
  segments: Segment[];
  ownship: Point | null;
  point?: Point | null;
  sources: TerrainSource[];
  sourceKey: string;
  airportKey?: string;
  base: string;
  tileUrl: string;
};
export type GlideWorker = { calculate(request: GlideRequest): Promise<GlideResult>; cancel(id: number): void };
export const emptyAreas = (): GlideAreas => ({ type: 'FeatureCollection', features: [] });
export const emptyLines = (): GlideLines => ({ type: 'FeatureCollection', features: [] });
