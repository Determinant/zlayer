import type { Feature, FeatureCollection, Point } from 'geojson';
import type { Bounds } from '@zlayer/contracts';
import type { Segment } from '../terrain/geometry';

export type ObstructionManifest = {
  schemaVersion: 1;
  generatedAt: string;
  horizontalDatum: 'WGS84';
  source: { name: string; lastModified?: string };
  dataset: { path: string; format: 'geojson'; compression: 'gzip'; sha256: string;
    bytes: number; uncompressedBytes: number; count: number };
};
export type ObstructionProperties = {
  heightAglFt: number; elevationMslFt: number; quantity: number;
  lightingCode: string; structureType: string; verified: boolean;
};
export type ObstructionFeature = Feature<Point, ObstructionProperties> & { id: string };
export type ObstructionMapProperties = {
  oas: string; icon: string; label: string; routeOpacity: number; elevationMslFt: number;
  heightAglFt: number; minZoom: number;
};
export type ObstructionCollection = FeatureCollection<Point, ObstructionMapProperties>;
export type ObstructionRequest = { manifestUrl: string; bounds: Bounds; segments: Segment[]; zoom: number };
export type ObstructionResult = { collection: ObstructionCollection; sourceDate?: string };
export type ObstructionWorker = { query: (request: ObstructionRequest) => Promise<ObstructionResult> };
export type ObstructionStatus = { state: 'idle' | 'zoom' | 'loading' | 'ready' | 'error';
  count?: number; sourceDate?: string; minHeightAglFt?: number; routeContext?: boolean };
