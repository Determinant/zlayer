import { terrainArchiveUrl, terrainArchiveKey, terrainShardKey, isTerrainIndex, type TerrainArchive, type TerrainIndex, type TerrainShard } from '@zlayer/contracts';
import { WholeFileChartCache } from '../charts/archive-cache';
import { CHART_CACHE } from '../../core/storage/cache-names';
import { verificationReceipt } from '../../core/storage/verification-receipt';
import { noteCacheAccess } from '../../core/storage/cache-access';
import { withAbort } from '../../core/data/abort';
import { InvalidDataError, ResourceError } from '../../core/data/errors';
import { readTerrainArchive } from './archive';
import type { Tile } from './geometry';

export type TerrainPackage = { root: string; shard: TerrainShard; grid?: 'EPSG:4326'; priority?: number };
const archives = new WholeFileChartCache(undefined, 8, 4);
type ParsedIndex = { data: TerrainIndex; byTile: ReadonlyMap<string, TerrainArchive> };
// Cache at most 8,192 archive descriptors. Pending parses share the same budget.
const indices = new Map<string, Promise<ParsedIndex>>();
const MAX_RESIDENT_INDICES = 8;

export async function readTerrainIndex(source: TerrainPackage, signal: AbortSignal, cacheOnly = false) {
  return (await readIndex(source, signal, cacheOnly)).data;
}

async function readIndex(source: TerrainPackage, signal: AbortSignal, cacheOnly = false): Promise<ParsedIndex> {
  const url = terrainArchiveUrl(source.root, source.shard), cache = await caches.open(CHART_CACHE);
  signal.throwIfAborted();
  let blob: Blob;
  if (cacheOnly) {
    const response = await cache.match(url);
    if (!response || response.status !== 200 || !verificationReceipt(response.headers, source.shard)) {
      await response?.body?.cancel();
      throw new ResourceError('storage', 'Saved terrain index is missing. Verify / update this region.');
    }
    blob = await response.blob();
  } else {
    await noteCacheAccess(CHART_CACHE, url);
    signal.throwIfAborted();
    // EnsureStored also repairs an evicted index still held by an in-memory reader.
    blob = (await withAbort(archives.ensureStored(cache, new Request(url)), signal)).blob;
  }
  signal.throwIfAborted();
  if (blob.size !== source.shard.byteLength) throw new InvalidDataError('Terrain index size mismatch');
  // Check persistent bytes before consulting parsed data: a warm index must not
  // conceal eviction from health checks or bypass ensureStored's repair path.
  const { shard } = source;
  const key = `${shard.sha256}:${shard.byteLength}:${terrainShardKey(shard.zoom, shard.x, shard.y)}`;
  let parsed = indices.get(key);
  if (parsed) indices.delete(key);
  else {
    const loading = parsed = parseIndex(blob, shard);
    void loading.catch(() => { if (indices.get(key) === loading) indices.delete(key); });
  }
  indices.set(key, parsed);
  while (indices.size > MAX_RESIDENT_INDICES) indices.delete(indices.keys().next().value!);
  // Cancel only this caller's wait; another tile may need the same parse.
  return withAbort(parsed, signal);
}

async function parseIndex(blob: Blob, shard: TerrainShard): Promise<ParsedIndex> {
  const value: unknown = JSON.parse(await blob.text());
  if (!isTerrainIndex(value) || value.archives.some(a => terrainShardKey(a.zoom, a.x, a.y) !==
    terrainShardKey(shard.zoom, shard.x, shard.y))) throw new InvalidDataError('Invalid terrain index');
  return { data: value, byTile: new Map(value.archives.map(a => [terrainArchiveKey(a.zoom, a.x, a.y), a])) };
}

export async function readPackagedElevation(tile: Tile, source: TerrainPackage, signal: AbortSignal, version: 1 | 2 = 1): Promise<Float32Array> {
  const index = await readIndex(source, signal);
  signal.throwIfAborted();
  if (index.data.schemaVersion !== version) throw new InvalidDataError('Terrain grid format mismatch');
  const archive = index.byTile.get(terrainArchiveKey(tile.z, tile.x, tile.y));
  if (!archive) throw new ResourceError('request', 'Terrain elevation is unavailable for this area');
  const url = terrainArchiveUrl(source.root, archive);
  const cache = await caches.open(CHART_CACHE);
  signal.throwIfAborted();
  await noteCacheAccess(CHART_CACHE, url);
  signal.throwIfAborted();
  const { blob } = await withAbort(archives.load(cache, new Request(url)), signal);
  return readTerrainArchive(blob, archive, tile, signal, version);
}
