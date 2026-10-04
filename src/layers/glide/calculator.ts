import { elevationGridLayout, readElevationGrid, type ElevationGrid, type ElevationReader } from '../../core/terrain/elevation';
import { ElevationTilePool } from '../../core/terrain/elevation-pool';
import { nmPerWorldUnit, type Point } from '../../core/geo/route-corridor';
import { ARRIVAL_RESERVE_FT, FEET_PER_NM, TERRAIN_CLEARANCE_FT } from './airports';
import { insideViewport, unwrapPoint, viewportBounds, type GlideViewport } from './coverage';
import { planningCellFactor } from './sampling';
import { prepareGlideProfile, profileFootprint, type GlideProfile } from './profile';

export type GlideOrigin = {
  coordinate: Point;
  viewport: GlideViewport;
  altitude: number;
  ratio: number;
  /** Present for an airport or selected-landing arrival calculation; absent for a forward glide. */
  elevationFt?: number;
};

/** One origin's terrain and profile. The planner owns all discovery, geometry,
 * source invalidation and cache budgets; this kernel never sees the camera. */
export class GlideCalculator {
  #grid: ElevationGrid | undefined;
  #loaded: Uint8Array | undefined;
  #key = '';
  #profile: GlideProfile | undefined;
  constructor(readonly read: ElevationReader, readonly pool = new ElevationTilePool()) {}

  get byteLength(): number {
    const profile = this.#profile;
    return (this.#grid?.values.byteLength ?? 0) + (this.#loaded?.byteLength ?? 0) +
      (profile ? profile.heights.byteLength + profile.caps.byteLength + profile.distances.byteLength : 0);
  }

  async calculate(origin: GlideOrigin, signal: AbortSignal) {
    signal.throwIfAborted();
    const { viewport, altitude, ratio, elevationFt } = origin;
    const bounds = viewportBounds(viewport), center = unwrapPoint(origin.coordinate, viewport);
    const sourceCells = this.pool.sourceCells;
    const work = { terrainSourceCells: 0, terrainCells: 0, profileCells: 0, profilesBuilt: 0, profilesReused: 0 };
    let zoom = 11, layout = elevationGridLayout(bounds, zoom);
    while (layout.width * layout.height > 512 * 512) layout = elevationGridLayout(bounds, --zoom);
    const factor = planningCellFactor(layout);
    layout = elevationGridLayout(bounds, zoom - Math.log2(factor));
    const key = JSON.stringify([viewport, center, zoom, factor]);
    if (key !== this.#key) {
      this.#key = key;
      this.#grid = { ...layout, values: new Float32Array(layout.width * layout.height).fill(NaN) };
      this.#loaded = new Uint8Array(layout.width * layout.height);
      this.#profile = undefined;
    }
    const grid = this.#grid!, loaded = this.#loaded!;
    const minScale = Math.min(nmPerWorldUnit(grid.y / grid.size), nmPerWorldUnit((grid.y + grid.height) / grid.size)) * FEET_PER_NM;
    const height = altitude - (elevationFt === undefined ? TERRAIN_CLEARANCE_FT : elevationFt + ARRIVAL_RESERVE_FT);
    // Sample whole planning cells around the reachable disk, including its halo.
    const radius = Math.min(Math.hypot(grid.width, grid.height) / grid.size,
      Math.ceil(Math.max(0, height) * ratio / minScale * grid.size / 16) * 16 / grid.size + 3 / grid.size);
    if (!this.#profile || this.#profile.radius < radius) {
      const mask = new Uint8Array(grid.width * grid.height);
      const left = Math.max(0, Math.floor((center[0] - radius) * grid.size) - grid.x);
      const right = Math.min(grid.width, Math.ceil((center[0] + radius) * grid.size) - grid.x);
      const top = Math.max(0, Math.floor((center[1] - radius) * grid.size) - grid.y);
      const bottom = Math.min(grid.height, Math.ceil((center[1] + radius) * grid.size) - grid.y);
      for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
        const index = y * grid.width + x;
        if (loaded[index]) continue;
        const point: Point = [(grid.x + x + .5) / grid.size, (grid.y + y + .5) / grid.size];
        if (Math.hypot(point[0] - center[0], point[1] - center[1]) > radius + 1 / grid.size || !insideViewport(point, viewport)) continue;
        mask[index] = 1; work.terrainCells++;
      }
      if (work.terrainCells) {
        const next = await readElevationGrid(this.read, bounds, zoom, signal, mask, { factor, tiles: this.pool });
        signal.throwIfAborted();
        for (let i = 0; i < mask.length; i++) if (mask[i]) { grid.values[i] = next.values[i]!; loaded[i] = 1; }
      }
      this.#profile = prepareGlideProfile(center, grid, viewport, radius);
      work.profilesBuilt++; work.profileCells += this.#profile.cells;
    } else work.profilesReused++;
    work.terrainSourceCells = this.pool.sourceCells - sourceCells;
    const profile = this.#profile;
    return { profile, footprint: profileFootprint(profile, altitude, ratio, elevationFt), work };
  }
}
