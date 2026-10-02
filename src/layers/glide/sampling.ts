import type { ElevationGrid } from '../../core/terrain/elevation';
import { nmPerWorldUnit } from '../../core/geo/route-corridor';

export const GLIDE_CELL_NM = .1;
/** Source resolution is retained for acquisition. Pool whole source cells once
 * for all origins, preserving peaks and unknowns instead of averaging heights. */
export function planningCellFactor(grid: Omit<ElevationGrid, 'values'>): number {
  const cellNm = Math.min(nmPerWorldUnit(grid.y / grid.size), nmPerWorldUnit((grid.y + grid.height) / grid.size)) / grid.size;
  return 2 ** Math.max(0, Math.ceil(Math.log2(GLIDE_CELL_NM / cellNm)));
}
