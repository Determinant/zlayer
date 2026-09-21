import { terrainArchiveKey, terrainArchiveUrl, terrainRegionKeys, terrainShardKey, type TerrainSource } from '@zlayer/contracts';
import type { DownloadPlan, OfflineFile } from '../../offline/downloads';
import { readTerrainIndex } from './packages';

export async function regionTerrainFiles(bounds: NonNullable<DownloadPlan['bounds']>, source: TerrainSource, base: string,
  signal: AbortSignal, cacheOnly = false): Promise<OfflineFile[]> {
  const groups = new Map<string, string[]>();
  for (const key of terrainRegionKeys(bounds, source)) {
    const [z, x, y] = key.split('/').map(Number) as [number, number, number];
    const group = terrainShardKey(z, x, y);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(key);
  }
  const shards = new Map(source.shards.map(shard => [terrainShardKey(shard.zoom, shard.x, shard.y), shard]));
  const files: OfflineFile[] = [], root = new URL(source.root, base).href;
  for (const [group, keys] of groups) {
    signal.throwIfAborted();
    const shard = shards.get(group);
    if (!shard) throw new Error('Terrain coverage is incomplete for this region. Retry after the terrain feed is updated.');
    const index = await readTerrainIndex({ root, shard }, signal, cacheOnly);
    if (index.schemaVersion !== source.schemaVersion || index.maxZoom !== source.maxZoom) {
      throw new Error('Terrain index format disagrees with its manifest');
    }
    files.push({ kind: 'terrain', url: terrainArchiveUrl(root, shard), byteLength: shard.byteLength, sha256: shard.sha256 });
    const archives = new Map(index.archives.map(a => [terrainArchiveKey(a.zoom, a.x, a.y), a]));
    for (const key of keys) {
      const archive = archives.get(key);
      if (!archive) throw new Error('Terrain coverage is incomplete for this region. Retry after the terrain feed is updated.');
      files.push({ kind: 'terrain', url: terrainArchiveUrl(root, archive), byteLength: archive.byteLength, sha256: archive.sha256 });
    }
  }
  return files;
}
