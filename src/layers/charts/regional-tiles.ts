import type { CatalogResponse } from '@zlayer/contracts';
import type { MultiPolygon } from 'polygon-clipping';
import { renderRasterBitmap } from '../../core/graphics/raster-bitmap';
import { browsingCatalog, regionalBundles, type CatalogReadSource } from '../../workspace/read-context';
import { partitionRegionCoverage } from '../../offline/region-coverage';
import { tileBounds } from './package-index';
import type { TileCoordinate } from './mbtiles-reader';

export type RegionalTilePart = { catalog: CatalogResponse; geometry: MultiPolygon };

/** Partition before fetching: absent saved pixels never reveal another edition. */
export function regionalTileParts(catalog: CatalogReadSource, tile: TileCoordinate): RegionalTilePart[] {
  const scale = 2 ** tile.z;
  return partitionRegionCoverage(regionalBundles(catalog), tileBounds(tile)).map(part => ({
    catalog: part.bundle?.catalog ?? browsingCatalog(catalog),
    geometry: part.geometry.map(polygon => polygon.map(ring => ring.map(([x, y]) =>
      [(x * scale - tile.x) * 256, (y * scale - tile.y) * 256]))),
  }));
}

export async function renderRegionalTile(parts: RegionalTilePart[], read: (catalog: CatalogResponse) =>
  Promise<ArrayBuffer | ImageBitmap | null>, signal: AbortSignal): Promise<ArrayBuffer | ImageBitmap | null> {
  if (parts.length === 1) return read(parts[0]!.catalog);
  return renderRasterBitmap(256, signal, async context => {
    // One decode per source edition, even when its area has several disjoint pieces.
    let failure: unknown;
    let readable = false;
    for (const catalog of new Set(parts.map(part => part.catalog))) {
      signal.throwIfAborted();
      let data: ArrayBuffer | ImageBitmap | null;
      try { data = await read(catalog); readable = true; }
      catch (error) { signal.throwIfAborted(); failure = error; continue; }
      if (!data) continue;
      const bitmap = data instanceof ArrayBuffer ? await createImageBitmap(new Blob([data])) : data;
      try {
        signal.throwIfAborted();
        context.save();
        context.beginPath();
        for (const part of parts) if (part.catalog === catalog) {
          for (const polygon of part.geometry) for (const ring of polygon) {
            context.moveTo(...ring[0]!);
            for (const point of ring.slice(1)) context.lineTo(...point);
            context.closePath();
          }
        }
        context.clip('evenodd');
        context.drawImage(bitmap, 0, 0, 256, 256);
        context.restore();
      } finally { bitmap.close(); }
    }
    if (!readable && failure) throw failure;
  });
}
