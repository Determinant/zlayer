import type { Point, Tile } from './geometry';
import { project } from './geometry';
import { packagesForElevationTile } from './geographic';
import type { ElevationTiles } from './elevation';
import type { TerrainPackage } from './packages';

/** Point details always use the finest supported DEM, independently of map zoom. */
export function terrainPointLocation([longitude, latitude]: Point): { tile: Tile; sampleIndex: number } | undefined {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(latitude) > 85.051129) return;
  const [x, y] = project([((longitude + 180) % 360 + 360) % 360 - 180, latitude]);
  const size = 2 ** 13 * 256;
  const column = Math.min(size - 1, Math.max(0, Math.floor(x * size)));
  const row = Math.min(size - 1, Math.max(0, Math.floor(y * size)));
  return { tile: { z: 13, x: Math.floor(column / 256), y: Math.floor(row / 256) },
    sampleIndex: (row % 256) * 256 + column % 256 };
}

export type TerrainPointRequest = {
  id: number;
  tile: Tile;
  sampleIndex: number;
  tileUrl: string;
  packages?: TerrainPackage[];
};

export async function readTerrainPoint(elevation: Pick<ElevationTiles, 'read'>,
  { tile, sampleIndex, tileUrl, packages }: TerrainPointRequest, signal: AbortSignal): Promise<number | null> {
  const source = packagesForElevationTile(packages ?? [], tile);
  const values = await elevation.read(tile, tileUrl, signal, source);
  signal.throwIfAborted();
  const height = values[sampleIndex];
  return height !== undefined && Number.isFinite(height) ? height : null;
}
