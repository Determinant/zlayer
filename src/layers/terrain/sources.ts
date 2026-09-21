import { terrainArchiveUrl, terrainShardKey, type TerrainSource } from '@zlayer/contracts';
import { jsonIdentity } from '../../core/data/json-identity';
import { browsingCatalog, regionalBundles, type CatalogReadSource } from '../../workspace/read-context';
import { geographicTiles } from './geographic';
import { terrainDetail } from './detail';
import type { Tile } from './geometry';
import type { TerrainPackage } from './packages';

const formatKey = (source: TerrainSource) => `${source.schemaVersion}:${source.maxZoom}`;

/** Saved indices take precedence over a newer feed, including offline reloads. */
export function terrainSources(catalog: CatalogReadSource | undefined): TerrainSource[] {
  if (!catalog) return [];
  const sources: TerrainSource[] = [];
  for (const bundle of regionalBundles(catalog)) {
    const terrain = bundle.catalog.terrain;
    if (!terrain) continue;
    const saved = new Set(bundle.plan.files.filter(file => file.kind === 'terrain').map(file => file.sha256));
    sources.push({ ...terrain, shards: terrain.shards.filter(file => saved.has(file.sha256)) });
  }
  const browsing = browsingCatalog(catalog).terrain;
  if (browsing) sources.push(browsing);
  return sources;
}

/** Keep the first source for each shard and preserve precedence across grid formats.
 * Metadata, storage health and shadowed sources do not invalidate already loaded tiles. */
export function terrainSourceKey(sources: readonly TerrainSource[], base: string): string {
  const selected = new Set<string>();
  const groups: Array<{ format: string; shards: Array<[string, string]> }> = [];
  for (const source of sources) {
    if (!source.shards.length) continue;
    const root = new URL(source.root, base).href, format = formatKey(source);
    const shards: Array<[string, string]> = [];
    for (const shard of source.shards) {
      const key = `${format}:${terrainShardKey(shard.zoom, shard.x, shard.y)}`;
      if (!selected.has(key)) {
        selected.add(key);
        shards.push([key, terrainArchiveUrl(root, shard)]);
      }
    }
    if (!shards.length) continue;
    // Consecutive sources of one format have no remaining overlap after deduplication.
    const previous = groups.at(-1);
    if (previous?.format === format) previous.shards.push(...shards);
    else groups.push({ format, shards });
  }
  for (const group of groups) group.shards.sort(([a], [b]) => a.localeCompare(b));
  return jsonIdentity(groups);
}

const indexes = new WeakMap<TerrainSource, Map<string, TerrainSource['shards'][number]>>();
export function packagesForTerrainTile(sources: readonly TerrainSource[], tile: Tile, base: string): TerrainPackage[] {
  const zoom = terrainDetail(tile.z).demZoom, factor = 2 ** (zoom - tile.z);
  const result = new Map<string, TerrainPackage>();
  for (let y = 0; y < factor; y++) for (let x = 0; x < factor; x++) {
    const demTile = { z: zoom, x: tile.x * factor + x, y: tile.y * factor + y };
    for (const [priority, source] of sources.entries()) {
      let index = indexes.get(source);
      if (!index) {
        index = new Map(source.shards.map(shard => [terrainShardKey(shard.zoom, shard.x, shard.y), shard]));
        indexes.set(source, index);
      }
      const tiles = source.schemaVersion === 2 ? geographicTiles(demTile, source.maxZoom) : [demTile];
      for (const t of tiles) {
        const key = terrainShardKey(t.z, t.x, t.y), identity = `${formatKey(source)}:${key}`;
        const shard = index.get(key);
        if (shard && !result.has(identity)) result.set(identity, { root: new URL(source.root, base).href, shard,
          ...(source.schemaVersion === 2 ? { grid: 'EPSG:4326' as const, maxZoom: source.maxZoom } : {}), priority });
      }
    }
  }
  return [...result.values()];
}
