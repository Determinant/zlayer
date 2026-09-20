import type { Database } from 'sql.js';

import { renderNativeTile, type MbtilesReader, type TileRenderer } from './mbtiles-reader';

// Keep complete compressed packages in memory, never decoded nationwide imagery.
// Larger custom packages use the legacy paged reader instead.
export const MAX_FAST_PACKAGE_BYTES = 4 * 1024 * 1024;
export const MAX_RESIDENT_PACKAGES = 16;
export type PackageTile = { z: number; x: number; y: number; data: ArrayBuffer };

export function extractPackageTiles(db: Database): PackageTile[] {
  const rows = db.exec('SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles LIMIT 65')[0]?.values;
  if (!rows?.length || rows.length > 64) throw new Error('Chart package must contain 1–64 tiles');
  const zoom = rows[0]![0];
  const seen = new Set<string>();
  return rows.map(([z, x, tmsY, data]) => {
    if (typeof z !== 'number' || !Number.isInteger(z) || z < 0 || z > 24 || z !== zoom ||
      typeof x !== 'number' || !Number.isInteger(x) || x < 0 || x >= 2 ** z ||
      typeof tmsY !== 'number' || !Number.isInteger(tmsY) || tmsY < 0 || tmsY >= 2 ** z ||
      !(data instanceof Uint8Array) || !data.byteLength) {
      throw new Error('Chart package contains invalid tiles');
    }
    const y = 2 ** z - tmsY - 1;
    const key = `${x}/${y}`;
    if (seen.has(key)) throw new Error('Chart package contains duplicate tiles');
    seen.add(key);
    return { z, x, y, data: data.slice().buffer };
  });
}

export function createPackageReader(rows: PackageTile[], renderTile?: TileRenderer) {
  const zoom = rows[0]!.z;
  const tiles = new Map(rows.map(tile => [`${tile.x}/${tile.y}`, tile.data]));
  const read: MbtilesReader = async (tile, signal) => {
    signal.throwIfAborted();
    // Package discovery selects the exact native zoom, or its overzoom parent.
    // Never use a different native level to fill transparent cutline holes.
    if (tile.z < zoom) return null;
    const scale = 2 ** (tile.z - zoom);
    const data = tiles.get(`${Math.floor(tile.x / scale)}/${Math.floor(tile.y / scale)}`);
    if (!data) return null;
    // MapLibre transfers/detaches the result. Keep the cached package intact.
    return renderNativeTile(data.slice(0), tile, zoom, signal, renderTile);
  };
  return { read, dispose: () => tiles.clear() };
}
