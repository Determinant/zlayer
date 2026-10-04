import clipping, { type MultiPolygon, type Polygon } from 'polygon-clipping';
import type { Bounds } from '@zlayer/contracts';
import { regionCoverage, uniformRectangleCoverage } from '../../offline/region-coverage';
import { project, type Point } from '../../core/geo/route-corridor';
import { landingRowSpans, polygonBounds } from './landing-geometry';
import { boundsViewport } from './coverage';
import type { LandingRegion, LandingScope } from './landing-sources';
import type { LandingManifest } from './landing-data';

const extents = new WeakMap<Polygon, Bounds>();
const extent = (p: Polygon) => { let b = extents.get(p); if (!b) { b = polygonBounds([p]); extents.set(p, b); } return b; };
/** Share the chart ownership geometry, keeping each region in the requested world copy. */
function localRegions(regions: LandingRegion[], [w, n, e, s]: Bounds): MultiPolygon {
  const result: MultiPolygon = [];
  for (const region of regions) {
    if (!region.bounds.some(b => {
      const nw = project([b[0], b[3]]), se = project([b[2], b[1]]);
      return nw[1] <= s && se[1] >= n && Math.ceil(w - se[0]) <= Math.floor(e - nw[0]);
    })) continue;
    for (const polygon of regionCoverage(region.id, region.bounds)) {
      const b = extent(polygon);
      if (b[1] > s || b[3] < n) continue;
      for (let copy = Math.ceil(w - b[2]); copy <= Math.floor(e - b[0]); copy++) {
        result.push(copy === 0 ? polygon : polygon.map(r => r.map(([x, y]) => [x + copy, y] as Point)));
      }
    }
  }
  return result;
}
export function scopedLandingMask(mask: MultiPolygon, scope?: LandingScope): MultiPolygon {
  if (!scope || !mask.length) return mask;
  const bounds = polygonBounds(mask), include = scope.include ? localRegions(scope.include, bounds) : undefined;
  const excluded = localRegions(scope.exclude, bounds);
  const contained = include ? uniformRectangleCoverage(include, bounds) : true;
  let selected = contained === true ? mask : contained === false || !include?.length ? [] : clipping.intersection(mask, include);
  if (selected.length && excluded.length) {
    const outside = uniformRectangleCoverage(excluded, bounds);
    selected = outside === true ? [] : outside === false ? selected : clipping.difference(selected, excluded);
  }
  return selected;
}
export function scopeIntersects(bounds: Bounds, scope: LandingScope): boolean {
  const east = bounds[2] < bounds[0] ? bounds[2] + 360 : bounds[2];
  const ring = boundsViewport([bounds[0], bounds[1], east, bounds[3]]);
  return scopedLandingMask([[ [...ring, ring[0]!] ]], scope).length > 0;
}
/** Boundary views use reusable scan-line spans, not a polygon walk per density sample. */
export function prepareHeatScope(scope?: LandingScope, bounds: Bounds = [0, 0, 1, 1]): ((x: number, y: number) => boolean) | undefined {
  if (!scope || !scope.include && !scope.exclude.length) return;
  const [w, n, e, s] = bounds, box: MultiPolygon = [[[[w, n], [e, n], [e, s], [w, s], [w, n]]]];
  const mask = scopedLandingMask(box, scope);
  if (mask === box) return;
  if (!mask.length) return () => false;
  const rows = new Map<number, [number, number][]>();
  return (x, y) => {
    x -= Math.round(x - (w + e) / 2);
    let spans = rows.get(y);
    if (!spans) {
      spans = landingRowSpans(mask, y);
      rows.set(y, spans);
    }
    return spans.some(([left, right]) => x >= left && x < right);
  };
}

/** Preparation coverage shares the exact regional ownership mask with detail. */
export function landingCoverageMask(manifest: LandingManifest, view: Bounds): MultiPolygon {
  const covered = manifest.coverage.flatMap(({ bounds: [west, south, east, north], scope }) => {
    if (south > view[3] || north < view[1]) return [];
    const polygons: Polygon[] = [];
    for (let copy = Math.ceil((view[0] - east) / 360); copy <= Math.floor((view[2] - west) / 360); copy++) {
      const ring = boundsViewport([west + copy * 360, south, east + copy * 360, north]);
      polygons.push([[...ring, ring[0]!]]);
    }
    return scopedLandingMask(polygons, scope);
  });
  return covered.length ? clipping.union(covered[0]!, ...covered.slice(1)) : [];
}
