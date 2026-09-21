import type { RasterSourceSpecification, StyleSpecification } from 'maplibre-gl';

export type MapView = { center: [number, number]; zoom: number; bearing?: number; pitch?: number };

// KPAO, at a regional scale; independent of feed ordering and chart selection.
export const DEFAULT_MAP_VIEW: MapView = { center: [-122.11504666, 37.46112138], zoom: 9 };

// USGS Topo includes shaded relief; the separate relief service has missing tiles.
const DEFAULT_BASEMAP_TILE_URL =
  'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}';

type BasemapOptions = Pick<
  ImportMetaEnv,
  'VITE_ZLAYERS_BASEMAP_STYLE_URL' | 'VITE_ZLAYERS_BASEMAP_TILE_URL'
>;

export function mapStyle(options: BasemapOptions = import.meta.env): string | StyleSpecification {
  const configuredStyleUrl = options.VITE_ZLAYERS_BASEMAP_STYLE_URL?.trim();
  if (configuredStyleUrl) return configuredStyleUrl;

  const tileUrl = options.VITE_ZLAYERS_BASEMAP_TILE_URL?.trim() || DEFAULT_BASEMAP_TILE_URL;
  return {
    version: 8,
    glyphs: '/fonts/{fontstack}/{range}.pbf',
    sources: {
      'zlayer-basemap': rasterSource(tileUrl),
    },
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: { 'background-color': '#dbe2df' },
      },
      {
        id: 'zlayer-basemap',
        type: 'raster',
        source: 'zlayer-basemap',
        paint: {
          'raster-fade-duration': 0,
          'raster-opacity': 1,
        },
      },
    ],
  };
}

function rasterSource(url: string): RasterSourceSpecification {
  return {
    type: 'raster',
    tiles: [url],
    tileSize: 256,
    minzoom: 0,
    maxzoom: 16,
    ...(url === DEFAULT_BASEMAP_TILE_URL
      ? { attribution: 'USGS The National Map' }
      : {}),
  };
}
