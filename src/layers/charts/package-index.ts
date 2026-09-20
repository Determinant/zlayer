import {
  chartPackageUrl, packageBoundsIntersect,
  type Bounds, type CatalogResponse, type ChartKind,
} from '@zlayer/contracts';

type Tile = { z: number; x: number; y: number };

export function tileBounds({ z, x, y }: Tile): Bounds {
  const n = 2 ** z;
  const latitude = (row: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * row / n))) * 180 / Math.PI;
  return [x / n * 360 - 180, latitude(y + 1), (x + 1) / n * 360 - 180, latitude(y)];
}

export function createChartPackageIndex(catalog: CatalogResponse, baseUrl?: string) {
  const index = catalog.chartPackages;
  if (!index) throw new Error('Chart packages are not available');
  // Development feeds use /chart-data. Resolve once at registration so readers
  // receive absolute URLs and share the service worker's whole-file cache keys.
  const root = baseUrl ? new URL(index.root, baseUrl).href : index.root;
  const addresses = new Map(index.archives.map(archive => [archive.id, {
    mask: BigInt(`0x${archive.tileMask}`), url: chartPackageUrl(root, archive),
  }]));
  const families = new Map<ChartKind, CatalogResponse['charts']>();
  for (const chart of catalog.charts) {
    const family = families.get(chart.kind) ?? [];
    family.push(chart);
    families.set(chart.kind, family);
  }
  return (kind: ChartKind, tile: Tile): string | undefined => {
    const area = tileBounds(tile);
    const covering = families.get(kind)?.filter(chart => packageBoundsIntersect(chart.bounds, area));
    if (!covering?.length) return undefined;
    // Preserve variable native resolution (e.g. Alaska vs Honolulu) without
    // storing thousands of needlessly upscaled tiles. Empty native cells are
    // indexed explicitly, so this never fills genuine cutline holes.
    const zoom = Math.min(tile.z, Math.max(...covering.map(chart => chart.maxZoom)));
    const scale = 2 ** (tile.z - zoom);
    const x = Math.floor(tile.x / scale);
    const y = Math.floor(tile.y / scale);
    for (let depth = Math.max(0, zoom - 3); depth <= zoom; depth += 1) {
      const span = 2 ** (zoom - depth);
      const rootX = Math.floor(x / span);
      const rootY = Math.floor(y / span);
      const archive = addresses.get(`${kind}-z${zoom}-r${depth}-${rootX}-${rootY}`);
      if (!archive) continue;
      const bit = BigInt((y - rootY * span) * span + x - rootX * span);
      return (archive.mask & (1n << bit)) !== 0n ? archive.url : undefined;
    }
    return undefined;
  };
}
