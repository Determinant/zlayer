import type { Bounds } from './types.js';
import { isRecord, isSha256, hasValidDate } from './validation.js';

/** Each archive contains four complete 256px DEMs at one native zoom. */
export type TerrainArchive = { zoom: number; x: number; y: number; file: string; byteLength: number; sha256: string;
  surface?: { file: string; byteLength: number; sha256: string } };
export type TerrainFormat = {
  schemaVersion: 1; encoding: 'float32-feet-gzip'; minZoom: 1; maxZoom: 13;
} | ({
  schemaVersion: 2; encoding: 'int16-metres-gzip'; minZoom: 1; grid: 'EPSG:4326';
} & ({ maxZoom: 10; resolutionArcSeconds: 4.9 } | { maxZoom: 11; resolutionArcSeconds: 2.45 }));
export type TerrainIndex = TerrainFormat & { archives: TerrainArchive[] };
export type TerrainShard = { zoom: number; x: number; y: number; file: string; byteLength: number; sha256: string };
export type TerrainManifest = TerrainFormat & { generatedAt: string; shards: TerrainShard[] };
export type TerrainSource = TerrainManifest & { root: string };
export const TERRAIN_SHARD_SPAN = 64;
export const terrainShardKey = (zoom: number, x: number, y: number) => `${zoom}/${Math.floor(x / 64) * 64}/${Math.floor(y / 64) * 64}`;
export const TERRAIN_ARCHIVE_MAX_BYTES = 2 * 1024 * 1024;
export const terrainArchiveKey = (zoom: number, x: number, y: number) => `${zoom}/${Math.floor(x / 2) * 2}/${Math.floor(y / 2) * 2}`;

export function isTerrainIndex(value: unknown): value is TerrainIndex {
  if (!isRecord(value) || !isTerrainFormat(value) ||
    !Array.isArray(value.archives) || !value.archives.length || value.archives.length > 1024) return false;
  const keys = new Set<string>();
  return value.archives.every(a => {
    if (!isRecord(a) || !Number.isInteger(a.zoom) || (a.zoom as number) < 1 || (a.zoom as number) > value.maxZoom ||
      !Number.isInteger(a.x) || !Number.isInteger(a.y) || (a.x as number) < 0 || (a.y as number) < 0 ||
      (a.x as number) % 2 !== 0 || (a.y as number) % 2 !== 0 ||
      (a.x as number) >= gridSize(value, a.zoom as number).columns || (a.y as number) >= gridSize(value, a.zoom as number).rows ||
      !isSha256(a.sha256) || a.file !== `${a.sha256}.dem` ||
      !Number.isSafeInteger(a.byteLength) || (a.byteLength as number) <= 56 ||
      (a.byteLength as number) > TERRAIN_ARCHIVE_MAX_BYTES) return false;
    if (a.surface !== undefined && (value.schemaVersion !== 2 || !isRecord(a.surface) ||
      !isSha256(a.surface.sha256) || a.surface.file !== `${a.surface.sha256}.dem` ||
      !Number.isSafeInteger(a.surface.byteLength) || (a.surface.byteLength as number) <= 56 ||
      (a.surface.byteLength as number) > TERRAIN_ARCHIVE_MAX_BYTES)) return false;
    const key = terrainArchiveKey(a.zoom as number, a.x as number, a.y as number);
    if (keys.has(key)) return false;
    keys.add(key); return true;
  });
}

export function terrainArchiveUrl(root: string, archive: Pick<TerrainArchive, 'file' | 'sha256' | 'byteLength'>): string {
  return `${root.replace(/\/+$/, '')}/${archive.file}?sha256=${archive.sha256}&bytes=${archive.byteLength}`;
}

/** Split dateline-crossing regions into separate bounds before calling. */
export function terrainRegionKeys(bounds: readonly Bounds[], format?: TerrainFormat): Set<string> {
  if (format?.schemaVersion === 2) return new Set(terrainRegionBlocks([{ bounds }], format.minZoom, format.maxZoom)
    .map(a => terrainArchiveKey(a.zoom, a.x, a.y)));
  const keys = new Set<string>();
  for (let zoom = 1; zoom <= 13; zoom++) {
    const n = 2 ** zoom;
    const column = (lon: number) => Math.max(0, Math.min(n - 1, Math.floor((lon + 180) / 360 * n)));
    const row = (lat: number) => Math.max(0, Math.min(n - 1, Math.floor((1 -
      Math.asinh(Math.tan(Math.max(-85.0511287798066, Math.min(85.0511287798066, lat)) * Math.PI / 180)) / Math.PI) / 2 * n)));
    for (const [west, south, east, north] of bounds) {
      for (let y = row(north) & ~1; y <= row(south); y += 2) {
        for (let x = column(west) & ~1; x <= column(east); x += 2) keys.add(terrainArchiveKey(zoom, x, y));
      }
    }
  }
  return keys;
}

export function isTerrainManifest(value: unknown): value is TerrainManifest {
  if (!isRecord(value) || !isTerrainFormat(value) ||
    typeof value.generatedAt !== 'string' || !hasValidDate(value.generatedAt) ||
    !Array.isArray(value.shards) || !value.shards.length) return false;
  const keys = new Set<string>();
  return value.shards.every(shard => {
    if (!isRecord(shard) || !Number.isInteger(shard.zoom) || (shard.zoom as number) < 1 || (shard.zoom as number) > value.maxZoom ||
      !Number.isInteger(shard.x) || !Number.isInteger(shard.y) || (shard.x as number) < 0 || (shard.y as number) < 0 ||
      (shard.x as number) % 64 || (shard.y as number) % 64 || (shard.x as number) >= gridSize(value, shard.zoom as number).columns ||
      (shard.y as number) >= gridSize(value, shard.zoom as number).rows || !isSha256(shard.sha256) || shard.file !== `${shard.sha256}.terrain` ||
      !Number.isSafeInteger(shard.byteLength) || (shard.byteLength as number) < 1 || (shard.byteLength as number) > 512 * 1024) return false;
    const key = terrainShardKey(shard.zoom as number, shard.x as number, shard.y as number);
    if (keys.has(key)) return false;
    keys.add(key); return true;
  });
}

function isTerrainFormat(value: Record<string, unknown>): value is Record<string, unknown> & TerrainFormat {
  return value.minZoom === 1 && (value.schemaVersion === 1
    ? value.encoding === 'float32-feet-gzip' && value.maxZoom === 13
    : value.schemaVersion === 2 && value.encoding === 'int16-metres-gzip' && value.grid === 'EPSG:4326' &&
      ((value.maxZoom === 10 && value.resolutionArcSeconds === 4.9) ||
       (value.maxZoom === 11 && value.resolutionArcSeconds === 2.45)));
}
const gridSize = (format: TerrainFormat, zoom: number) => format.schemaVersion === 2 ? terrainGridSize(zoom)
  : { columns: 2 ** zoom, rows: 2 ** zoom };

/** Keep geometry synchronized with faa-regs lib/terrain-grid.ts.
 * Geographic cells are anchored at (-180, 90); zoom 11 is exactly 2.45 arc-seconds.
 * Coarser levels double that spacing. Tile and archive edges never shift the grid. */
export const TERRAIN_RESOLUTION_ARC_SECONDS = 2.45;
export const TERRAIN_MAX_ZOOM = 11;
export const TERRAIN_NODATA = -32768;
export const terrainSpacing = (zoom: number) => TERRAIN_RESOLUTION_ARC_SECONDS / 3600 * 2 ** (TERRAIN_MAX_ZOOM - zoom);
export const terrainGridSize = (zoom: number) => ({
  columns: Math.ceil(360 / terrainSpacing(zoom) / 256), rows: Math.ceil(180 / terrainSpacing(zoom) / 256)
});
export type GeographicBounds = readonly [number, number, number, number];

export function terrainRegionBlocks(regions: readonly { bounds: readonly GeographicBounds[] }[], minZoom = 1, maxZoom = TERRAIN_MAX_ZOOM) {
  const blocks = new Map<string, { zoom: number; x: number; y: number }>();
  for (let zoom = minZoom; zoom <= maxZoom; zoom++) {
    const size = terrainGridSize(zoom), span = terrainSpacing(zoom) * 256;
    const col = (lon: number) => Math.max(0, Math.min(size.columns - 1, Math.floor((lon + 180) / span)));
    const row = (lat: number) => Math.max(0, Math.min(size.rows - 1, Math.floor((90 - lat) / span)));
    for (const region of regions) for (const [west, south, east, north] of region.bounds) {
      for (let y = row(north) & ~1; y <= row(south); y += 2) {
        for (let x = col(west) & ~1; x <= col(east); x += 2) blocks.set(`${zoom}/${x}/${y}`, { zoom, x, y });
      }
    }
  }
  return [...blocks.values()].sort((a, b) => a.zoom - b.zoom || a.x - b.x || a.y - b.y);
}

export function terrainGridBounds(zoom: number, x: number, y: number, span = 2, paddingPixels = 0): [number, number, number, number] {
  const step = terrainSpacing(zoom);
  return [Math.max(-180, -180 + (x * 256 - paddingPixels) * step),
    Math.max(-90, 90 - ((y + span) * 256 + paddingPixels) * step),
    Math.min(180, -180 + ((x + span) * 256 + paddingPixels) * step),
    Math.min(90, 90 - (y * 256 - paddingPixels) * step)];
}
