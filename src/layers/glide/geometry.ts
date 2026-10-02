import clipping, { type Polygon, type MultiPolygon } from 'polygon-clipping';
import { unproject, type Point } from '../../core/geo/route-corridor';
import type { GlideAreas, GlideLines } from './types';
import { GLIDE_SECTORS, type GlideProfile } from './profile';
import { glideSectorPaths, simplifyGlidePath } from './outline';

/** Boolean union before rendering removes every internal overlap edge; holes survive. */
export function mergeFootprints(polygons: Polygon[], mask?: MultiPolygon): GlideAreas {
  if (!polygons.length) return { type: 'FeatureCollection', features: [] };
  if (mask && !mask.length) return { type: 'FeatureCollection', features: [] };
  const union = clipping.union(polygons[0]!, ...polygons.slice(1));
  const merged = mask ? clipping.intersection(union, mask) : union;
  // Clip each world separately so antimeridian footprints never draw across Earth.
  const coordinates = merged.flatMap(polygon => {
    let left = Infinity, right = -Infinity;
    for (const ring of polygon) for (const [x] of ring) { left = Math.min(left, x); right = Math.max(right, x); }
    const pieces: GeoJSON.Position[][][] = [];
    for (let world = Math.floor(left); world <= Math.floor(right); world++) {
      for (const part of clipping.intersection(polygon, [[[world, 0], [world + 1, 0], [world + 1, 1], [world, 1], [world, 0]]])) {
        pieces.push(part.map(ring => ring.map(([x, y]) => unproject([x - world, y]))));
      }
    }
    return pieces;
  });
  return { type: 'FeatureCollection', features: coordinates.length ? [{ type: 'Feature', properties: {},
    geometry: { type: 'MultiPolygon', coordinates } }] : [] };
}

/** Only actual reach boundaries are drawn for ownship. A viewport-limited sector
 * is an unfinished ring, never a false glide limit along the screen edge. */
export function ownshipOutline(profile: GlideProfile, radii: readonly number[], unknown?: Uint8Array): GlideLines {
  const boundary = glideSectorPaths(profile.center, radii, profile.minScale);
  const paths: Point[][] = [];
  let path: Point[] = [];
  const finish = () => {
    if (path.length > 1) paths.push(simplifyGlidePath(path, profile.maxScale, GLIDE_SECTORS / 4));
    path = [];
  };
  for (let sector = 0; sector < GLIDE_SECTORS; sector++) {
    const radius = radii[sector]!;
    // Classify using the unsmoothed result: the inset must not manufacture a
    // glide limit out of a viewport cap. Unknown/zero sectors remain open gaps.
    const sectorPath = boundary[sector]!, a = sectorPath[0]!, b = sectorPath.at(-1)!;
    if (unknown?.[sector] || radius <= 0 || radius >= profile.caps[sector]! - 1e-12 || (a[0] === b[0] && a[1] === b[1])) { finish(); continue; }
    if (!path.length) path.push(a);
    path.push(...sectorPath.slice(1));
  }
  finish();
  return { type: 'FeatureCollection', features: paths.length ? [{ type: 'Feature', properties: {},
    geometry: { type: 'MultiLineString', coordinates: paths.map(path => path.map(unproject)) } }] : [] };
}
