import { terrainArchiveUrl, terrainArchiveKey, terrainShardKey, isTerrainIndex, type TerrainArchive, type TerrainIndex, type TerrainShard } from '@zlayer/contracts';
import { WholeFileCache } from '../../core/storage/archive-cache';
import { CHART_CACHE } from '../../core/storage/cache-names';
import { verificationReceipt } from '../../core/storage/verification-receipt';
import { noteCacheAccess } from '../../core/storage/cache-access';
import { withAbort } from '../../core/data/abort';
import { InvalidDataError, ResourceError } from '../../core/data/errors';
import { readTerrainArchive } from './archive';
import { openFileCache, storedFileBlob } from '../../core/storage/download-file';
import { discardResponseBody } from '../../core/storage/response';
import type { Tile } from './geometry';

export type TerrainPackage = { root: string; shard: TerrainShard; grid?: 'EPSG:4326'; maxZoom?: 10 | 11; priority?: number };
const archives = new WholeFileCache(undefined, 8);
type ParsedIndex = { data: TerrainIndex; byTile: ReadonlyMap<string, TerrainArchive> };
// Cache at most 8,192 archive descriptors. Pending parses share the same budget.
const indices = new Map<string, Promise<ParsedIndex>>();
const MAX_RESIDENT_INDICES = 8;

export async function readTerrainIndex(source: TerrainPackage, signal: AbortSignal, cacheOnly = false) {
  return (await readIndex(source, signal, cacheOnly)).data;
}

async function readIndex(source: TerrainPackage, signal: AbortSignal, cacheOnly = false): Promise<ParsedIndex> {
  const url = terrainArchiveUrl(source.root, source.shard), cache = await openFileCache(CHART_CACHE);
  signal.throwIfAborted();
  let blob: Blob;
  if (cacheOnly) {
    const response = await cache.match(url);
    if (!response || response.status !== 200 || !verificationReceipt(response.headers, source.shard)) {
      await response?.body?.cancel();
      throw new ResourceError('storage', 'Saved terrain index is missing. Verify / update this region.');
    }
    try { blob = await storedFileBlob(response); } finally { discardResponseBody(response); }
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

export async function readPackagedElevation(tile: Tile, source: TerrainPackage, signal: AbortSignal, version: 1 | 2 = 1,
  surface = false): Promise<Float32Array> {
  const index = await readIndex(source, signal);
  signal.throwIfAborted();
  if (index.data.schemaVersion !== version || (source.maxZoom !== undefined && index.data.maxZoom !== source.maxZoom)) {
    throw new InvalidDataError('Terrain grid format mismatch');
  }
  if (terrainShardKey(tile.z, tile.x, tile.y) !== terrainShardKey(source.shard.zoom, source.shard.x, source.shard.y)) {
    throw new InvalidDataError('Terrain tile does not match its index');
  }
  const entry = index.byTile.get(terrainArchiveKey(tile.z, tile.x, tile.y));
  // Indices can cover only part of their 64×64 tile area. Keep uncovered cells
  // unknown so one coverage gap does not discard the other DEMs in a map tile.
  // Rendering still reports incomplete terrain; download/integrity errors above
  // and archive failures below retain their ordinary error paths.
  if (!entry) return new Float32Array(256 * 256).fill(NaN);
  // Older saved packages contain only maxima. They still provide a usable
  // surface without fetching another dataset or changing clearance heights.
  const archive = surface && entry.surface ? { ...entry, ...entry.surface } : entry;
  const url = terrainArchiveUrl(source.root, archive);
  const cache = await openFileCache(CHART_CACHE);
  signal.throwIfAborted();
  await noteCacheAccess(CHART_CACHE, url);
  signal.throwIfAborted();
  const { blob } = await withAbort(archives.load(cache, new Request(url)), signal);
  return readTerrainArchive(blob, archive, tile, signal, version);
}
