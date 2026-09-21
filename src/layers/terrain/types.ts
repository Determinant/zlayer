import type { TerrainLabel } from './contours';
import type { Segment, Tile } from './geometry';
import type { TerrainIsoline } from './isolines';
import type { TerrainPackage } from './packages';
import type { TerrainBorder } from './seams';
import type { TerrainCorridor } from './corridor';

export type TerrainCoverage = 'route' | 'viewport';
export type TerrainStatus = { state: 'idle' | 'zoom' | 'loading' | 'ready' | 'error'; interval: 500 | 1000; overview?: boolean; coverage?: TerrainCoverage };
export type TerrainRequest = { id: number; tile: Tile; segments: Segment[]; tileUrl: string; packages?: TerrainPackage[]; coverage?: TerrainCoverage };
export type TerrainResult = { data: ImageBitmap | null; labels: TerrainLabel[]; lines: TerrainIsoline[]; borders?: TerrainBorder[]; incomplete?: boolean };
export type TerrainWorker = {
  corridor: (segments: Segment[]) => Promise<TerrainCorridor>;
  render: (request: TerrainRequest) => Promise<TerrainResult>;
  cancel: (id: number) => void;
};
