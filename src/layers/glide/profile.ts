import type { ElevationGrid } from '../../core/terrain/elevation';
import { nmPerWorldUnit, type Point } from '../../core/geo/route-corridor';
import { insideViewport, viewportRayDistance, type GlideViewport } from './coverage';
import { ARRIVAL_RESERVE_FT, TERRAIN_CLEARANCE_FT, FEET_PER_NM } from './airports';
import type { Polygon } from 'polygon-clipping';
import { glideBoundary, simplifyGlidePath } from './outline';
export const GLIDE_SECTORS = 360;
const TAU = Math.PI * 2;
export type GlideProfile = { center: Point; step: number; bins: number; heights: Float32Array; caps: Float64Array;
  distances: Float64Array; maxScale: number; minScale: number; radius: number; cells: number };

/** One preparation per origin/visible DEM/range bucket. Altitude and ratio changes
 * subsequently scan the compact polar profile, without rescanning terrain cells. */
export function prepareGlideProfile(center: Point, grid: ElevationGrid, viewport: GlideViewport, radius: number): GlideProfile {
  const step = 1 / grid.size, bins = Math.ceil(radius / step) + 1;
  const north = grid.y / grid.size, south = (grid.y + grid.height) / grid.size;
  const maxScale = nmPerWorldUnit(Math.max(north, Math.min(south, .5))) * FEET_PER_NM;
  const minScale = Math.min(nmPerWorldUnit(north), nmPerWorldUnit(south)) * FEET_PER_NM;
  const caps = Float64Array.from({ length: GLIDE_SECTORS }, (_, sector) => Math.max(0, Math.min(radius,
    Math.min(viewportRayDistance(center, sector / GLIDE_SECTORS * TAU, viewport, 3 * step),
      viewportRayDistance(center, (sector + 1) / GLIDE_SECTORS * TAU, viewport, 3 * step)) * Math.cos(TAU / GLIDE_SECTORS))));
  const heights = new Float32Array(GLIDE_SECTORS * bins).fill(-Infinity);
  const distances = new Float64Array(GLIDE_SECTORS * (bins + 1));
  // Bound path length on each radial interval across the WHOLE sector. Using
  // one cumulative upper metric in both directions is essential: U(d)-U(s)
  // bounds the return segment because each increment bounds that interval.
  // It avoids the excessive U(d)-L(s) penalty of window-wide scale extrema.
  for (let sector = 0; sector < GLIDE_SECTORS; sector++) {
    const a = sector / GLIDE_SECTORS * TAU, b = (sector + 1) / GLIDE_SECTORS * TAU;
    const low = a <= 3 * Math.PI / 2 && b >= 3 * Math.PI / 2 ? -1 : Math.min(Math.sin(a), Math.sin(b));
    const high = a <= Math.PI / 2 && b >= Math.PI / 2 ? 1 : Math.max(Math.sin(a), Math.sin(b));
    const offset = sector * (bins + 1);
    for (let bin = 0; bin < bins; bin++) {
      const near = bin * step, far = (bin + 1) * step;
      const north = center[1] + Math.min(near * low, far * low), south = center[1] + Math.max(near * high, far * high);
      const scale = nmPerWorldUnit(Math.max(north, Math.min(south, .5))) * FEET_PER_NM;
      distances[offset + bin + 1] = distances[offset + bin]! + step * scale;
    }
  }
  const left = Math.max(0, Math.floor((center[0] - radius) * grid.size) - grid.x);
  const right = Math.min(grid.width, Math.ceil((center[0] + radius) * grid.size) - grid.x);
  const top = Math.max(0, Math.floor((center[1] - radius) * grid.size) - grid.y);
  const bottom = Math.min(grid.height, Math.ceil((center[1] + radius) * grid.size) - grid.y);
  let cells = 0;
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
    const point: Point = [(grid.x + x + .5) / grid.size, (grid.y + y + .5) / grid.size];
    if (!insideViewport(point, viewport)) continue;
    const dx = point[0] - center[0], dy = point[1] - center[1];
    const half = step / 2;
    const near = Math.hypot(Math.max(0, Math.abs(dx) - half), Math.max(0, Math.abs(dy) - half));
    if (near > radius) continue;
    cells++;
    const height = grid.values[y * grid.width + x]!;
    const value = Number.isFinite(height) ? height : Infinity;
    const far = Math.hypot(Math.abs(dx) + half, Math.abs(dy) + half);
    const firstBin = Math.floor(near / step), lastBin = Math.min(bins - 1, Math.floor(far / step));
    const bearing = Math.atan2(dy, dx);
    let low = Math.PI, high = -Math.PI;
    if (Math.abs(dx) < half && Math.abs(dy) < half) { low = -Math.PI; high = Math.PI; }
    else for (const x of [dx - half, dx + half]) for (const y of [dy - half, dy + half]) {
      if (x === 0 && y === 0) continue;
      const angle = Math.atan2(dx * y - dy * x, dx * x + dy * y);
      low = Math.min(low, angle); high = Math.max(high, angle);
    }
    // Use the square cell's actual angular extent. A circumscribed circle
    // spreads adjacent valley-wall heights across directions that miss the cell.
    const first = Math.floor((bearing + low) / TAU * GLIDE_SECTORS), last = Math.floor((bearing + high) / TAU * GLIDE_SECTORS);
    for (let sector = first; sector <= last; sector++) {
      const index = (sector % GLIDE_SECTORS + GLIDE_SECTORS) % GLIDE_SECTORS;
      for (let bin = firstBin; bin <= lastBin && bin * step < caps[index]!; bin++) {
        const offset = index * bins + bin; heights[offset] = Math.max(heights[offset]!, value);
      }
    }
  }
  return { center, step, bins, heights, caps, distances, maxScale, minScale, radius, cells };
}

export function profileFootprint(profile: GlideProfile, altitude: number, ratio: number, fieldElevation?: number): {
  polygon: Polygon; incomplete: boolean; radii: number[]; unknown: Uint8Array;
} {
  const { center, step, bins, caps, heights, distances, maxScale, minScale } = profile;
  const reverse = fieldElevation !== undefined;
  let incomplete = false;
  const unknown = new Uint8Array(GLIDE_SECTORS);
  const radii = Array.from({ length: GLIDE_SECTORS }, (_, sector) => {
    let floor = reverse ? fieldElevation + ARRIVAL_RESERVE_FT : -Infinity, radius = 0;
    for (let bin = 0; bin < bins && bin * step < caps[sector]!; bin++) {
      const height = heights[sector * bins + bin]!;
      if (height === Infinity || height === -Infinity) { incomplete = true; unknown[sector] = 1; break; }
      const far = Math.min(caps[sector]!, (bin + 1) * step);
      const nearDistance = distances[sector * (bins + 1) + bin]!;
      const increment = distances[sector * (bins + 1) + bin + 1]! - nearDistance;
      const farDistance = nearDistance + (far / step - bin) * increment;
      if (reverse) floor = Math.max(floor, height + TERRAIN_CLEARANCE_FT - nearDistance / ratio);
      else floor = Math.max(0, height) + TERRAIN_CLEARANCE_FT;
      if (floor + farDistance / ratio > altitude) {
        // The whole-bin maximum proves the same inequality at every shorter
        // distance in this bin. Solve it instead of dropping the entire bin.
        radius = Math.max(radius, Math.max(0, Math.min(far, (bin + ((altitude - floor) * ratio - nearDistance) / increment) * step)));
        break;
      }
      radius = far;
    }
    return radius;
  });
  const ring = simplifyGlidePath(glideBoundary(center, radii, minScale), maxScale, GLIDE_SECTORS / 4);
  return { polygon: [ring], incomplete, radii, unknown };
}
