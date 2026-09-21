import { TERRAIN_MAX_ZOOM, terrainSpacing, terrainGridSize, terrainShardKey, terrainArchiveUrl } from '@zlayer/contracts';
import { withAbort } from '../../core/data/abort';
import { ResourceError } from '../../core/data/errors';
import { readPackagedElevation, type TerrainPackage } from './packages';
import { TerrainWorkLimit } from './work-limit';
import type { Tile } from './geometry';

/** Map each Mercator pixel footprint to geographic cells. Maxima over all
 * intersecting cells keep thin peaks from falling between display samples. */
export function geographicSamples(tile: Tile) {
  const zoom = Math.min(TERRAIN_MAX_ZOOM, tile.z), step = terrainSpacing(zoom), n = 2 ** tile.z;
  const size = terrainGridSize(zoom);
  const longitudeEdges = Array.from({ length: 257 }, (_, x) => (tile.x + x / 256) / n * 360 / step);
  const latitudeEdges = Array.from({ length: 257 }, (_, y) => {
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (tile.y + y / 256) / n))) * 180 / Math.PI;
    return (90 - lat) / step;
  });
  const starts = (edges: number[], limit: number) => edges.slice(0, 256).map(v => Math.max(0, Math.min(limit - 1, Math.floor(v))));
  const ends = (edges: number[], limit: number) => edges.slice(1).map(v => Math.max(0, Math.min(limit - 1, Math.ceil(v) - 1)));
  return { zoom, columns: starts(longitudeEdges, size.columns * 256), rows: starts(latitudeEdges, size.rows * 256),
    columnEnds: ends(longitudeEdges, size.columns * 256), rowEnds: ends(latitudeEdges, size.rows * 256) };
}

export function geographicTiles(tile: Tile): Tile[] {
  const { zoom, columns, rows, columnEnds, rowEnds } = geographicSamples(tile);
  const result: Tile[] = [];
  for (let y = Math.floor(rows[0]! / 256); y <= Math.floor(rowEnds[255]! / 256); y++) {
    for (let x = Math.floor(columns[0]! / 256); x <= Math.floor(columnEnds[255]! / 256); x++) result.push({ z: zoom, x, y });
  }
  return result;
}

/** Preserve source order across saved legacy and geographic packages. */
export function packagesForElevationTile(packages: readonly TerrainPackage[], tile: Tile): TerrainPackage[] {
  const keys = new Set(geographicTiles(tile).map(t => terrainShardKey(t.z, t.x, t.y)));
  const legacyKey = terrainShardKey(tile.z, tile.x, tile.y);
  const candidates = packages.filter(p => p.grid ? keys.has(terrainShardKey(p.shard.zoom, p.shard.x, p.shard.y))
    : terrainShardKey(p.shard.zoom, p.shard.x, p.shard.y) === legacyKey)
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  return candidates[0]?.grid ? candidates.filter(p => p.grid) : candidates.slice(0, 1);
}

// 32 completed geographic grids = 8 MiB. Keep pending reads separate so cache
// pressure cannot evict a shared job and start duplicate downloads/decompression.
const decoded = new Map<string, Float32Array>();
type PendingGrid = { controller: AbortController; promise: Promise<Float32Array>; readers: number };
const pendingGrids = new Map<string, PendingGrid>();
const gridReads = new TerrainWorkLimit(4);
async function geographicGrid(tile: Tile, source: TerrainPackage, signal: AbortSignal) {
  signal.throwIfAborted();
  const key = `${terrainArchiveUrl(source.root, source.shard)}#${tile.z}/${tile.x}/${tile.y}`;
  const cached = decoded.get(key);
  if (cached) { decoded.delete(key); decoded.set(key, cached); return cached; }
  let job = pendingGrids.get(key);
  if (!job) {
    const controller = new AbortController();
    const promise = gridReads.run(controller.signal, async () => {
      const values = await readPackagedElevation(tile, source, controller.signal, 2);
      controller.signal.throwIfAborted();
      decoded.set(key, values);
      while (decoded.size > 32) decoded.delete(decoded.keys().next().value!);
      return values;
    }).finally(() => { if (pendingGrids.get(key) === job) pendingGrids.delete(key); });
    job = { controller, promise, readers: 0 };
    pendingGrids.set(key, job);
  }
  job.readers++;
  try { return await withAbort(job.promise, signal); }
  finally {
    // Cancel the remaining index/archive/decode work only when no reader needs
    // it. Remove first so a retry cannot join the aborted job or be deleted by it.
    if (--job.readers === 0 && pendingGrids.get(key) === job) {
      pendingGrids.delete(key);
      job.controller.abort();
    }
  }
}

export async function readGeographicElevation(tile: Tile, sources: readonly TerrainPackage[], signal: AbortSignal, onIncomplete?: () => void): Promise<Float32Array> {
  signal.throwIfAborted();
  const samples = geographicSamples(tile), values = new Float32Array(256 * 256).fill(NaN);
  const grids = new Map<string, Float32Array>();
  const loaded = await Promise.allSettled(geographicTiles(tile).map(async t => {
    const key = terrainShardKey(t.z, t.x, t.y);
    const source = sources.find(s => terrainShardKey(s.shard.zoom, s.shard.x, s.shard.y) === key);
    if (source) grids.set(`${t.x}/${t.y}`, await geographicGrid(t, source, signal));
  }));
  signal.throwIfAborted();
  const failures = loaded.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  // At a saved region edge, unavailable neighbouring cells stay visibly missing.
  // Corrupt data is never accepted, and a wholly failed request retains its error.
  const failure = failures.find(r => !(r.reason instanceof ResourceError) || !['request', 'http'].includes(r.reason.code))
    ?? (!grids.size ? failures[0] : undefined);
  if (failure) throw failure.reason;
  if (failures.length) onIncomplete?.();
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    let height = -Infinity;
    for (let row = samples.rows[y]!; row <= samples.rowEnds[y]!; row++) {
      for (let column = samples.columns[x]!; column <= samples.columnEnds[x]!; column++) {
        const grid = grids.get(`${Math.floor(column / 256)}/${Math.floor(row / 256)}`);
        const sample = grid?.[(row % 256) * 256 + column % 256];
        // As in simplifyElevation, one unknown contributor makes the whole
        // footprint unknown; a neighbouring valid height cannot prove clearance.
        height = sample !== undefined && Number.isFinite(sample) ? Math.max(height, sample) : NaN;
      }
    }
    if (Number.isFinite(height)) values[y * 256 + x] = height;
  }
  return values;
}
