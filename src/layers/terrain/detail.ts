/** Work follows screen scale: at most four 256px DEMs per displayed 512px tile.
 * Overview contour geometry uses a height sample per 4 screen pixels. Heights
 * are interpolated before assigning solid bands; painted colors are never blurred. */
export function terrainDetail(zoom: number) {
  const z = Math.floor(zoom);
  return {
    demZoom: Math.min(13, z + 1),
    gridSize: z < 10 ? 128 : z < 12 ? 256 : 512,
    interval: contourInterval(z),
    lines: true,
    contourLabels: z < 10 ? 0 : z < 12 ? 2 : 3,
  };
}

export function contourInterval(zoom: number): 500 | 1000 { return zoom >= 11 ? 500 : 1000; }
export const MIN_TERRAIN_ZOOM = 8;

// MapLibre raster sources choose their canonical tile zoom by rounding.
export function terrainTileZoom(zoom: number): number { return Math.max(8, Math.min(13, Math.round(zoom))); }
