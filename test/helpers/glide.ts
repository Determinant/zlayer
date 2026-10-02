import type { ElevationGrid } from '../../src/core/terrain/elevation';
import { insideViewport, type GlideViewport } from '../../src/layers/glide/coverage';
import { planningCellFactor } from '../../src/layers/glide/sampling';
import { project, nmPerWorldUnit } from '../../src/core/geo/route-corridor';
import { ARRIVAL_RESERVE_FT, FEET_PER_NM } from '../../src/layers/glide/airports';
import type { GlideAirport } from '../../src/layers/glide/types';
import { prepareGlideProfile, profileFootprint } from '../../src/layers/glide/profile';

/** Independent full-grid max-pooling reference for terrain regressions. */
export function planningElevationGrid(grid: ElevationGrid, viewport: GlideViewport): ElevationGrid {
  const factor = planningCellFactor(grid);
  if (factor === 1) return grid;
  const x = Math.floor(grid.x / factor), y = Math.floor(grid.y / factor), size = grid.size / factor;
  const width = Math.ceil((grid.x + grid.width) / factor) - x, height = Math.ceil((grid.y + grid.height) / factor) - y;
  const values = new Float32Array(width * height).fill(NaN);
  for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
    if (!insideViewport([(x + col + .5) / size, (y + row + .5) / size], viewport)) continue;
    const left = (x + col) * factor - grid.x, top = (y + row) * factor - grid.y;
    // An incomplete block, including missing or unrequested source cells, stays
    // unknown. Inset viewport caps keep such screen-edge blocks out of profiles.
    if (left < 0 || top < 0 || left + factor > grid.width || top + factor > grid.height) continue;
    let maximum = -Infinity, known = true;
    for (let dy = 0; dy < factor && known; dy++) for (let dx = 0; dx < factor; dx++) {
      const value = grid.values[(top + dy) * grid.width + left + dx]!;
      if (!Number.isFinite(value)) { known = false; break; }
      maximum = Math.max(maximum, value);
    }
    if (known) values[row * width + col] = maximum;
  }
  return { x, y, size, width, height, values };
}

/** Isolated reverse-glide math fixture. */
export function airportFootprint(airport: GlideAirport, altitude: number, ratio: number, grid: ElevationGrid) {
  const center = project(airport.coordinate);
  const viewport: GlideViewport = [[grid.x / grid.size, grid.y / grid.size], [(grid.x + grid.width) / grid.size, grid.y / grid.size],
    [(grid.x + grid.width) / grid.size, (grid.y + grid.height) / grid.size], [grid.x / grid.size, (grid.y + grid.height) / grid.size]];
  const scale = nmPerWorldUnit(center[1]) * FEET_PER_NM;
  const radius = Math.max(0, altitude - airport.elevationFt - ARRIVAL_RESERVE_FT) * ratio / scale;
  return profileFootprint(prepareGlideProfile(center, grid, viewport, radius), altitude, ratio, airport.elevationFt);
}
