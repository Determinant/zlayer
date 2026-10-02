import type { TerrainSource } from '@zlayer/contracts';
import type { ElevationReader } from '../../core/terrain/elevation';
import { ElevationTiles } from './elevation';
import { packagesForTerrainTile } from './sources';
import { packagesForElevationTile } from './geographic';
export { terrainSources, terrainSourceKey } from './sources';
export { DEFAULT_ELEVATION_URL, TERRAIN_ATTRIBUTION } from './elevation';

/** Data-only provider for core sampling, independent of Terrain's map visibility. */
export function createTerrainElevationReader(sources: readonly TerrainSource[], base: string, tileUrl: string): ElevationReader {
  const tiles = new ElevationTiles();
  return (tile, signal) => tiles.read(tile, tileUrl, signal,
    packagesForElevationTile(packagesForTerrainTile(sources, { z: tile.z - 1, x: Math.floor(tile.x / 2), y: Math.floor(tile.y / 2) }, base), tile));
}
