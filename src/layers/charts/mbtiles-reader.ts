import { renderRasterBitmap } from '../../core/graphics/raster-bitmap';

export type TileCoordinate = { z: number; x: number; y: number };
type TileQuery = (sql: string, parameters: number[]) => Promise<unknown>;
type TileRow = { data: Uint8Array | ArrayBuffer };
type OverviewRow = TileRow & { x: number; y: number };
type TilePart = { data: ArrayBuffer; x: number; y: number; size: number };
export type TileRenderer = (parts: TilePart[], signal: AbortSignal) => Promise<ImageBitmap>;
export type MbtilesReader = (
  tile: TileCoordinate,
  signal: AbortSignal,
) => Promise<ArrayBuffer | ImageBitmap | null>;

const TILE_SIZE = 256;

export async function createMbtilesReader(
  query: TileQuery,
  renderTile: TileRenderer = renderTileParts,
): Promise<MbtilesReader> {
  // Inspect both ends of the tile index once per archive, without scanning all
  // rows. Older manifests misstated both the minimum and maximum stored zoom.
  const levels = await query(
    `SELECT
       (SELECT zoom_level FROM tiles ORDER BY zoom_level LIMIT 1) AS minZoom,
       (SELECT zoom_level FROM tiles ORDER BY zoom_level DESC LIMIT 1) AS maxZoom`, [],
  ) as Array<{ minZoom: number; maxZoom: number }>;
  const minimumZoom = levels[0]?.minZoom;
  const maximumZoom = levels[0]?.maxZoom;
  if (!isZoom(minimumZoom) || !isZoom(maximumZoom) || minimumZoom > maximumZoom) {
    throw new Error('MBTiles archive has no valid tile zoom level');
  }

  return async (tile, signal) => {
    signal.throwIfAborted();
    const tmsY = 2 ** tile.z - tile.y - 1;
    if (tile.z >= minimumZoom) {
      const zoom = Math.min(tile.z, maximumZoom);
      const scale = 2 ** (tile.z - zoom);
      const rows = await query(
        `SELECT tile_data AS data FROM tiles
         WHERE zoom_level = ? AND tile_column = ? AND tile_row = ? LIMIT 1`,
        [zoom, Math.floor(tile.x / scale), Math.floor(tmsY / scale)],
      ) as TileRow[];
      signal.throwIfAborted();
      // Native missing tiles (including a missing overzoom parent) are clipped
      // coverage. Only resample above the actual maximum, never fill native holes.
      if (!rows[0]) return null;
      const data = exactArrayBuffer(rows[0].data);
      return renderNativeTile(data, tile, zoom, signal, renderTile);
    }

    const scale = 2 ** (minimumZoom - tile.z);
    const firstX = tile.x * scale;
    const firstY = tmsY * scale;
    const rows = await query(
      `SELECT tile_data AS data, tile_column AS x, tile_row AS y FROM tiles
       WHERE zoom_level = ? AND tile_column BETWEEN ? AND ?
       AND tile_row BETWEEN ? AND ?`,
      [minimumZoom, firstX, firstX + scale - 1, firstY, firstY + scale - 1],
    ) as OverviewRow[];
    signal.throwIfAborted();
    if (rows.length === 0) return null;

    const size = TILE_SIZE / scale;
    return renderTile(rows.map((row) => ({
      data: exactArrayBuffer(row.data),
      x: (row.x - firstX) * size,
      // MBTiles rows run south to north; canvas pixels run north to south.
      y: (firstY + scale - 1 - row.y) * size,
      size,
    })), signal);
  };
}

export function renderNativeTile(
  data: ArrayBuffer, tile: TileCoordinate, zoom: number, signal: AbortSignal,
  renderTile: TileRenderer = renderTileParts,
): ArrayBuffer | Promise<ImageBitmap> {
  const scale = 2 ** (tile.z - zoom);
  if (scale === 1) return data;
  return renderTile([{
    data, x: -(tile.x % scale) * TILE_SIZE, y: -(tile.y % scale) * TILE_SIZE,
    size: TILE_SIZE * scale,
  }], signal);
}

function isZoom(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 24;
}

function renderTileParts(
  parts: TilePart[],
  signal: AbortSignal,
): Promise<ImageBitmap> {
  return renderRasterBitmap(TILE_SIZE, signal, async context => {
    context.imageSmoothingQuality = 'high';
    // Decode one cached source tile at a time, retaining transparent chart edges.
    for (const part of parts) {
      signal.throwIfAborted();
      const bitmap = await createImageBitmap(new Blob([part.data]));
      try {
        signal.throwIfAborted();
        context.drawImage(bitmap, part.x, part.y, part.size, part.size);
      } finally { bitmap.close(); }
    }
  });
}

function exactArrayBuffer(value: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}
