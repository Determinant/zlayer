import clipping, { type MultiPolygon } from 'polygon-clipping';
import earcut from 'earcut';
import type { Bounds } from '@zlayer/contracts';
import { jsonIdentity } from '../../core/data/json-identity';
import type { Point, Segment } from '../../core/geo/route-corridor';
import { localRouteSegments, routeMask } from './coverage';
import type { LandingShard } from './landing-data';
import type { LandingHeat, LandingHeatFrame } from './landing-heat';
import { colorLandingDensity, composeLandingDensity, type LandingDensity } from './landing-heat-composition';
import { scopedLandingMask } from './landing-scope';

export type LandingHeatEntry = { shard: LandingShard; heat: LandingHeat };
export type LandingHeatLevel = ReturnType<typeof colorLandingDensity>;
export type LandingHeatTile = {
  key: string; extent: Bounds; vertices: Float32Array; levels: LandingHeatLevel[];
};
export type LandingHeatUpdate = LandingHeatTile | { key: string; extent?: never; vertices?: never; levels?: never };
const rectangle = ([w, n, e, s]: Bounds): MultiPolygon => [[[[w, n], [e, n], [e, s], [w, s], [w, n]]]];
const overlaps = (a: Bounds, b: Bounds) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

/** The finest resident observation owns even its empty pixels. A coarse tile
 * can supply the remainder only within the same release and regional scope. */
export function landingHeatMosaic(entries: LandingHeatEntry[]): LandingHeat[] {
  const owners = entries.map(({ shard }) => shard.package ? jsonIdentity([shard.package.root, shard.scope]) : undefined);
  return entries.map(({ shard, heat }, i) => {
    if (!shard.package) return heat;
    const [z, x, y] = shard.package.block.tile;
    const exclude = entries.flatMap((entry, j) => {
      if (owners[j] !== owners[i] || !entry.shard.package) return [];
      const [cz, cx, cy] = entry.shard.package.block.tile, scale = 2 ** (cz - z);
      return cz > z && Math.floor(cx / scale) === x && Math.floor(cy / scale) === y ? [entry.heat.extent] : [];
    });
    return exclude.length ? { ...heat, exclude } : heat;
  });
}

/** Fixed geographic resolution; never depends on the viewport or camera zoom.
 * Power-of-two dimensions make every mip an exact 2×2 area reduction. */
function tileFrame(heat: LandingHeat): LandingHeatFrame {
  const [left, top, right, bottom] = heat.extent;
  const step = Math.max((right - left) / Math.min(256, heat.width), (bottom - top) / Math.min(256, heat.height));
  const size = (span: number) => Math.min(256, 2 ** Math.ceil(Math.log2(Math.max(1, span / step))));
  return { left, top, width: size(right - left), height: size(bottom - top), step };
}

/** Average numeric fractions, then color each level. Averaging already colored
 * RGBA would erase sparse candidates and mix purple/green into a third tier. */
export function landingHeatPyramid(density: LandingDensity): LandingHeatLevel[] {
  const levels: LandingHeatLevel[] = [];
  let current = density;
  for (;;) {
    levels.push(colorLandingDensity(current));
    if (current.width === 1 && current.height === 1) return levels;
    const width = Math.max(1, current.width / 2), height = Math.max(1, current.height / 2);
    const sx = current.width / width, sy = current.height / height;
    const coverage = new Float32Array(width * height), preference = new Float32Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const at = y * width + x;
      for (let dy = 0; dy < sy; dy++) for (let dx = 0; dx < sx; dx++) {
        const source = (y * sy + dy) * current.width + x * sx + dx;
        coverage[at]! += current.coverage[source]! / (sx * sy);
        preference[at]! += current.preference[source]! / (sx * sy);
      }
    }
    current = { width, height, coverage, preference };
  }
}

/** Triangulate the clipped boundary directly, with explicit hole offsets.
 * Splitting every edge at every vertex Y amplified complex regional masks into
 * quadratic work and storage. Earcut spatially indexes larger polygons, and its
 * triangle count is linear in boundary vertices and holes. Keep double precision
 * in tile-local coordinates until the completed mesh is packed for the GPU. */
function maskVertices(mask: MultiPolygon, frame: LandingHeatFrame): Float32Array {
  // polygon-clipping returns closed rings. A polygon with N distinct ring
  // vertices and H holes needs at most N + 2H - 2 triangles; collinear vertices
  // may reduce that count. Allocate once rather than growing a JS number array.
  const vertexCount = (polygon: MultiPolygon[number]) => polygon.reduce((sum, ring) => sum + ring.length - 1, 0);
  const triangles = mask.reduce((sum, polygon) => sum + Math.max(0, vertexCount(polygon) + 2 * (polygon.length - 1) - 2), 0);
  const vertices = new Float32Array(triangles * 6);
  const { left, top, width, height, step } = frame;
  let written = 0;
  for (const polygon of mask) {
    const coordinates = new Float64Array(vertexCount(polygon) * 2), holes: number[] = [];
    let offset = 0;
    for (let ringIndex = 0; ringIndex < polygon.length; ringIndex++) {
      const ring = polygon[ringIndex]!;
      if (ringIndex) holes.push(offset / 2);
      for (let i = 0; i + 1 < ring.length; i++) {
        const [x, y] = ring[i]!;
        coordinates[offset++] = (x - left) / (width * step);
        coordinates[offset++] = (y - top) / (height * step);
      }
    }
    for (const index of earcut(coordinates, holes)) {
      vertices[written++] = coordinates[index * 2]!;
      vertices[written++] = coordinates[index * 2 + 1]!;
    }
  }
  return vertices.subarray(0, written);
}

/** Build the source dependency graph only when resident inputs change. Neither
 * camera movement nor route edits change source ownership or tile coordinates. */
function tileGraph(entries: LandingHeatEntry[], scopes: WeakMap<LandingHeatEntry, MultiPolygon>) {
  const ordered = [...entries].sort((a, b) => {
    const area = ({ heat: { extent: e } }: LandingHeatEntry) => (e[2] - e[0]) * (e[3] - e[1]);
    return area(a) - area(b) || a.shard.file.localeCompare(b.shard.file);
  });
  const masks = ordered.map(entry => {
    let mask = scopes.get(entry);
    if (!mask) { mask = scopedLandingMask(rectangle(entry.heat.extent), entry.heat.scope); scopes.set(entry, mask); }
    return mask;
  });
  const mosaic = landingHeatMosaic(ordered);
  return ordered.map((entry, index) => {
    const frame = tileFrame(entry.heat), { left, top, width, height, step } = frame;
    const extent: Bounds = [left, top, left + width * step, top + height * step];
    const view = rectangle(extent)[0]![0]!.slice(0, 4) as Point[];
    const neighbors = ordered.flatMap((other, i) => {
      if (!overlaps(extent, other.heat.extent)) return [];
      // A new parent contributes nothing inside its resident child.
      const replaced = mosaic[i]!.exclude?.some(([w, n, e, s]) => w <= left && n <= top && e >= extent[2] && s >= extent[3]);
      return replaced ? [] : [i];
    });
    return { entry, frame, extent, view, mask: masks[index]!, above: neighbors.filter(i => i < index).flatMap(i => masks[i]!),
      heats: neighbors.map(i => mosaic[i]!), inputs: neighbors.map(i => ordered[i]!.shard.file) };
  });
}

/** Retained geographic assets, including all zoom levels. Warm camera queries
 * return before graph construction, local-leg clipping or signature generation. */
export function createLandingHeatTiles() {
  const cache = new Map<string, { signature: string; tile: LandingHeatTile | null }>();
  let scopes = new WeakMap<LandingHeatEntry, MultiPolygon>();
  let inputs = new Map<string, LandingHeatEntry>(), graph: ReturnType<typeof tileGraph> = [];
  let graphDirty = true, routeKey: string | undefined, tiles: LandingHeatTile[] = [], version = 0;
  return {
    clear() { cache.clear(); scopes = new WeakMap(); inputs.clear(); graph = []; graphDirty = true; routeKey = undefined; tiles = []; },
    evict(file: string) {
      cache.delete(file); inputs.delete(file);
      // Release graph references immediately, even if acquisition is canceled
      // before preparation. The last published pixels remain valid until replaced.
      graph = []; graphDirty = true;
    },
    prepare(entries: LandingHeatEntry[], segments: Segment[]): LandingHeatTile[] {
      const changed = graphDirty || entries.length !== inputs.size || entries.some(entry => inputs.get(entry.shard.file) !== entry);
      const nextRoute = JSON.stringify(segments);
      if (!changed && nextRoute === routeKey) return tiles;
      if (changed) {
        graph = tileGraph(entries, scopes);
        graphDirty = false;
        inputs = new Map(entries.map(entry => [entry.shard.file, entry]));
        for (const id of cache.keys()) if (!inputs.has(id)) cache.delete(id);
      }
      const nextTiles = graph.flatMap(({ entry, frame, extent, view, mask: scope, above, heats, inputs }) => {
        const local = localRouteSegments(segments, view);
        const signature = JSON.stringify([local, inputs]);
        let cached = cache.get(entry.shard.file);
        if (cached?.signature !== signature) {
          let mask = local.length ? clipping.intersection(scope, routeMask(local, view)) : [];
          if (mask.length && above.length) mask = clipping.difference(mask, above);
          let tile: LandingHeatTile | null = null;
          if (mask.length) {
            const levels = landingHeatPyramid(composeLandingDensity(heats, frame, local));
            if (levels[0]!.shadedCells) tile = { key: String(++version), extent, vertices: maskVertices(mask, frame), levels };
          }
          cached = { signature, tile }; cache.set(entry.shard.file, cached);
        }
        return cached.tile ? [cached.tile] : [];
      });
      // A distant leg edit can leave every asset unchanged as well.
      if (nextTiles.length !== tiles.length || nextTiles.some((tile, i) => tile !== tiles[i])) tiles = nextTiles;
      routeKey = nextRoute;
      return tiles;
    },
  };
}
