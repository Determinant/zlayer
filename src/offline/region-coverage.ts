import type { Bounds } from '@zlayer/contracts';
import clipping, { type MultiPolygon, type Pair, type Polygon } from 'polygon-clipping';
import { feature } from 'topojson-client';
import type { GeometryCollection, Topology, Polygon as TopoPolygon, MultiPolygon as TopoMultiPolygon } from 'topojson-specification';
import boundaries from './region-boundaries.json';
import type { SavedBundle } from './bundle-repository';
import { OFFLINE_REGIONS } from './regions';

// World coordinates keep point ownership and chart clipping in the same Mercator
// space. Census polygons are split at the date line before they reach this module.
type StateProperties = { STUSAB: string };
const topology = boundaries as unknown as Topology<{ states: GeometryCollection<StateProperties> }>;
const states = new Map(topology.objects.states.geometries
  .filter((shape): shape is TopoPolygon<StateProperties> | TopoMultiPolygon<StateProperties> => shape.type === 'Polygon' || shape.type === 'MultiPolygon')
  .map(shape => [`us-${shape.properties?.STUSAB}`, shape]));
const projected = new Map<string, MultiPolygon>();
const extents = new WeakMap<Polygon, Bounds>();
const envelopes = new Map(OFFLINE_REGIONS.map(region => [region.id, region.bounds]));
const partitions = new WeakMap<readonly SavedBundle[], Map<string, RegionCoverage[]>>();
export type RegionCoverage = { bundle?: SavedBundle; geometry: MultiPolygon };

export function worldPoint([longitude, latitude]: readonly number[]): Pair {
  const lat = Math.max(-85.0511287798066, Math.min(85.0511287798066, latitude!));
  return [(longitude! + 180) / 360, (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2];
}

export function regionCoverage(regionId: string | undefined, bounds: readonly Bounds[]): MultiPolygon {
  const shape = regionId ? states.get(regionId) : undefined;
  if (!regionId || !shape) return bounds.map(area => worldRectangle(area)[0]!);
  let geometry = projected.get(regionId);
  if (!geometry) {
    const decoded = shape.type === 'Polygon' ? feature(topology, shape).geometry : feature(topology, shape).geometry;
    const polygons = decoded.type === 'Polygon' ? [decoded.coordinates] : decoded.coordinates;
    geometry = polygons.map(polygon => polygon.map(ring => ring.map(worldPoint)));
    projected.set(regionId, geometry);
  }
  return geometry;
}

export function regionContainsPoint(regionId: string | undefined, bounds: readonly Bounds[], coordinates: readonly number[]): boolean {
  const [longitude, latitude] = coordinates;
  const wrapped = ((longitude! + 180) % 360 + 360) % 360 - 180;
  const areas = (regionId && envelopes.get(regionId)) || bounds;
  if (!areas.some(([w, s, e, n]) => wrapped >= w && wrapped <= e && latitude! >= s && latitude! <= n)) return false;
  return coverageContainsPoint(regionCoverage(regionId, bounds), worldPoint([wrapped, latitude!]));
}

export function coverageContainsPoint(geometry: MultiPolygon, point: Pair): boolean {
  return geometry.some(polygon => {
    const [west, north, east, south] = polygonBounds(polygon);
    if (point[0] < west || point[0] > east || point[1] < north || point[1] > south) return false;
    const outer = inRing(polygon[0]!, point);
    return outer === 2 || (outer === 1 && !polygon.slice(1).some(ring => inRing(ring, point) === 1));
  });
}

/** Resolve ownership before reading bytes. Missing data cannot change the edition.
 * Readers and badges share this partition, including legacy rectangular regions. */
export function partitionRegionCoverage(bundles: readonly SavedBundle[], viewport: Bounds): RegionCoverage[] {
  let cache = partitions.get(bundles);
  if (!cache) { cache = new Map(); partitions.set(bundles, cache); }
  const key = viewport.join(',');
  const cached = cache.get(key);
  if (cached) return cached;
  const result: RegionCoverage[] = [];
  for (const area of wrappedViewport(viewport)) {
    let remaining = worldRectangle(area);
    const extent = polygonBounds(remaining[0]!);
    for (const bundle of bundles) {
      if (!remaining.length) break;
      const candidates = regionCoverage(bundle.plan.regionId, bundle.bounds)
        .filter(polygon => intersects(polygonBounds(polygon), extent));
      if (!candidates.length) continue;
      const geometry = clipping.intersection(remaining, candidates);
      if (!geometry.length) continue;
      result.push({ bundle, geometry });
      remaining = clipping.difference(remaining, geometry);
    }
    if (remaining.length) result.push({ geometry: remaining });
  }
  cache.set(key, result);
  if (cache.size > 32) cache.delete(cache.keys().next().value!);
  return result;
}

function worldRectangle([west, south, east, north]: Bounds): MultiPolygon {
  const [left, top] = worldPoint([west, north]), [right, bottom] = worldPoint([east, south]);
  return [[[[left, top], [right, top], [right, bottom], [left, bottom], [left, top]]]];
}

function polygonBounds(polygon: Polygon): Bounds {
  let value = extents.get(polygon);
  if (!value) {
    value = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of polygon[0]!) {
      value[0] = Math.min(value[0], x); value[1] = Math.min(value[1], y);
      value[2] = Math.max(value[2], x); value[3] = Math.max(value[3], y);
    }
    extents.set(polygon, value);
  }
  return value;
}

function intersects(a: Bounds, b: Bounds): boolean {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

// 0 = outside, 1 = inside, 2 = edge. A shared edge belongs to the first bundle.
function inRing(ring: Pair[], [x, y]: Pair): number {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j]!, [bx, by] = ring[i]!;
    if ((bx - ax) * (y - ay) === (by - ay) * (x - ax) &&
      x >= Math.min(ax, bx) && x <= Math.max(ax, bx) && y >= Math.min(ay, by) && y <= Math.max(ay, by)) return 2;
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside ? 1 : 0;
}

function wrappedViewport([west, south, east, north]: Bounds): Bounds[] {
  if (east < west) east += 360;
  const width = east - west;
  if (width >= 360) return [[-180, south, 180, north]];
  west = ((west + 180) % 360 + 360) % 360 - 180;
  east = west + width;
  return east <= 180 ? [[west, south, east, north]]
    : [[west, south, 180, north], [-180, south, east - 360, north]];
}
