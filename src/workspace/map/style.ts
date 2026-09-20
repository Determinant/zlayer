import type { RasterSourceSpecification, StyleSpecification } from 'maplibre-gl';

export type MapView = { center: [number, number]; zoom: number; bearing?: number; pitch?: number };

// KPAO, at a regional scale; independent of feed ordering and chart selection.
export const DEFAULT_MAP_VIEW: MapView = { center: [-122.11504666, 37.46112138], zoom: 9 };

const DEFAULT_BASEMAP_REFERENCE_TILE_URL =
  'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}';
const BASEMAP_RELIEF_TILE_URL =
  'https://basemap.nationalmap.gov/arcgis/rest/services/USGSShadedReliefOnly/MapServer/tile/{z}/{y}/{x}';
const BASEMAP_REFERENCE_OPACITY = 0.58;

type BasemapOptions = Pick<
  ImportMetaEnv,
  'VITE_ZLAYERS_BASEMAP_STYLE_URL' | 'VITE_ZLAYERS_BASEMAP_TILE_URL'
>;

export function mapStyle(options: BasemapOptions = import.meta.env): string | StyleSpecification {
  const configuredStyleUrl = options.VITE_ZLAYERS_BASEMAP_STYLE_URL?.trim();
  if (configuredStyleUrl) return configuredStyleUrl;

  const referenceTileUrl = options.VITE_ZLAYERS_BASEMAP_TILE_URL?.trim() ||
    DEFAULT_BASEMAP_REFERENCE_TILE_URL;
  const useDefaultBasemap = referenceTileUrl === DEFAULT_BASEMAP_REFERENCE_TILE_URL;
  const style: StyleSpecification = {
    version: 8,
    glyphs: '/fonts/{fontstack}/{range}.pbf',
    sources: {
      'zlayer-basemap': rasterSource(referenceTileUrl),
    },
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: { 'background-color': '#dbe2df' },
      },
    ],
  };
  if (useDefaultBasemap) {
    style.sources['zlayer-basemap-relief'] = rasterSource(BASEMAP_RELIEF_TILE_URL);
    style.layers.push({
      id: 'zlayer-basemap-relief',
      type: 'raster',
      source: 'zlayer-basemap-relief',
      paint: {
        'raster-contrast': 0.15,
        'raster-fade-duration': 0,
      },
    });
  }
  style.layers.push({
    id: 'zlayer-basemap',
    type: 'raster',
    source: 'zlayer-basemap',
    paint: {
      'raster-fade-duration': 0,
      'raster-opacity': useDefaultBasemap ? BASEMAP_REFERENCE_OPACITY : 1,
    },
  });
  return style;
}

function rasterSource(url: string): RasterSourceSpecification {
  return {
    type: 'raster',
    tiles: [url],
    tileSize: 256,
    minzoom: 0,
    maxzoom: 16,
    ...(url === DEFAULT_BASEMAP_REFERENCE_TILE_URL || url === BASEMAP_RELIEF_TILE_URL
      ? { attribution: 'USGS The National Map' }
      : {}),
  };
}
