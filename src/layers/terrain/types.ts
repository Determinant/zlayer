import type { TerrainLabel } from './contours';
import type { Segment, Tile } from './geometry';
import type { TerrainIsoline } from './isolines';

export type TerrainStatus = { state: 'idle' | 'zoom' | 'loading' | 'ready' | 'error'; interval: 500 | 1000; overview?: boolean };
export type TerrainRequest = { id: number; tile: Tile; segments: Segment[]; tileUrl: string };
export type TerrainResult = { data: ImageBitmap | null; labels: TerrainLabel[]; lines: TerrainIsoline[]; incomplete?: boolean };
export type TerrainWorker = {
  render: (request: TerrainRequest) => Promise<TerrainResult>;
  cancel: (id: number) => void;
};
