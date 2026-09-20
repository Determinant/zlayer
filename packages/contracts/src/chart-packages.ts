import type { Bounds, ChartKind } from './types.js';
import { isRecord as object, isNonEmptyString as text, isNonNegativeInteger as integer, isStrictBounds as bounds } from './validation.js';

export type ChartPackageArchive = {
  id: string;
  kind: Exclude<ChartKind, 'unknown'>;
  file: string;
  zoom: number;
  root: { z: number; x: number; y: number };
  bounds: Bounds;
  tileMask: string;
  byteLength: number;
  sha256: string;
};
export type ChartOfflineRegion = { id: string; title: string; bounds: Bounds[]; archiveIds: string[] };
export type ChartPackageIndex = {
  maximumArchiveBytes: number;
  archives: ChartPackageArchive[];
  regions: ChartOfflineRegion[];
};

const kinds = new Set(['vfr-sectional', 'vfr-terminal', 'vfr-flyway', 'ifr-low']);

function archive(value: unknown): value is ChartPackageArchive {
  if (!object(value) || !text(value.id) || !text(value.kind) || !kinds.has(value.kind) ||
      !integer(value.zoom) || value.zoom > 24 || !object(value.root) ||
      !integer(value.root.z) || value.root.z > value.zoom || value.root.z < Math.max(0, value.zoom - 3) ||
      !integer(value.root.x) || !integer(value.root.y) ||
      value.root.x >= 2 ** value.root.z || value.root.y >= 2 ** value.root.z ||
      !bounds(value.bounds) || !text(value.sha256) || !/^[a-f0-9]{64}$/.test(value.sha256) ||
      !integer(value.byteLength) || value.byteLength === 0 || !text(value.tileMask) ||
      !/^[a-f0-9]{1,16}$/.test(value.tileMask)) return false;
  const root = { z: value.root.z, x: value.root.x, y: value.root.y };
  const depth = value.root.z;
  const n = 2 ** depth;
  const latitude = (row: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * row / n))) * 180 / Math.PI;
  const expectedBounds = [root.x / n * 360 - 180, latitude(root.y + 1), (root.x + 1) / n * 360 - 180, latitude(root.y)];
  if (value.bounds.some((coordinate, index) => Math.abs(coordinate - expectedBounds[index]!) > 1e-9)) return false;
  if (value.id !== `${value.kind}-z${value.zoom}-r${root.z}-${root.x}-${root.y}` ||
      value.file !== `${value.id}-${value.sha256}.mbtiles`) return false;
  const bits = BigInt(`0x${value.tileMask}`);
  return bits > 0n && bits < (1n << BigInt(4 ** (value.zoom - depth)));
}

export function packageBoundsIntersect(a: Bounds, b: Bounds): boolean {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

export function isChartPackageIndex(value: unknown): value is ChartPackageIndex {
  if (!object(value) || !integer(value.maximumArchiveBytes) || value.maximumArchiveBytes < 32768 ||
      !Array.isArray(value.archives) || value.archives.length === 0 || !value.archives.every(archive) ||
      !Array.isArray(value.regions)) return false;
  const addresses = new Set<string>();
  for (const item of value.archives) {
    if (item.byteLength > value.maximumArchiveBytes || addresses.has(item.id)) return false;
    addresses.add(item.id);
  }
  for (const item of value.archives) {
    for (let z = Math.max(0, item.zoom - 3); z < item.root.z; z += 1) {
      const scale = 2 ** (item.root.z - z);
      if (addresses.has(`${item.kind}-z${item.zoom}-r${z}-${Math.floor(item.root.x / scale)}-${Math.floor(item.root.y / scale)}`)) return false;
    }
  }
  const regions = new Set<string>();
  for (const region of value.regions) {
    if (!object(region) || !text(region.id) || !text(region.title) || regions.has(region.id) ||
        !Array.isArray(region.bounds) || !region.bounds.length || !region.bounds.every(bounds) ||
        !Array.isArray(region.archiveIds) || !region.archiveIds.every(text)) return false;
    regions.add(region.id);
    const ids = new Set(region.archiveIds);
    if (ids.size !== region.archiveIds.length || [...ids].some(id => !addresses.has(id))) return false;
    // A region is a completeness promise, not just a list of recently viewed files.
    const areas = region.bounds;
    if (value.archives.some(item => areas.some(area => packageBoundsIntersect(area, item.bounds)) && !ids.has(item.id))) return false;
  }
  return true;
}

export function chartPackageUrl(root: string, archive: ChartPackageArchive): string {
  return `${root}/${archive.file}?sha256=${archive.sha256}&bytes=${archive.byteLength}`;
}
