interface ImportMetaEnv {
  readonly VITE_ZLAYERS_BASEMAP_STYLE_URL?: string;
  readonly VITE_ZLAYERS_BASEMAP_TILE_URL?: string;
  readonly VITE_ZLAYERS_TERRAIN_TILE_URL?: string;
  readonly VITE_ZLAYERS_CHART_ROOT?: string;
  readonly VITE_ZLAYERS_CHART_REVISION?: string;
  readonly VITE_ZLAYERS_METAR_URL?: string;
  readonly VITE_ZLAYERS_TAF_URL?: string;
  readonly VITE_ZLAYERS_AWC_GRID_URL?: string;
  readonly VITE_ZLAYERS_AWC_FEED_URL?: string;
  readonly VITE_ZLAYERS_RADAR_FEED_URL?: string;
  readonly VITE_ZLAYERS_PROGS_FEED_URL?: string;
  readonly VITE_ZLAYERS_PROCEDURE_PROXY_ROOT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
