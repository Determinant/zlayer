import { GRID_BELOW_GROUND, GRID_MISSING, GRID_OUTSIDE, GRID_UNKNOWN, type AwcGridField } from '@zlayer/contracts';

export const isGridSentinel = (value: number) => value === GRID_MISSING || value === GRID_BELOW_GROUND || value === GRID_UNKNOWN || value === GRID_OUTSIDE;
export function validGridValue(field: AwcGridField, value: number): boolean {
  if (isGridSentinel(value)) return true;
  if (!Number.isFinite(value)) return false;
  if (field === 'temperature') return value >= -143.2 && value <= 76.9;
  if (field === 'windEast' || field === 'windNorth') return Math.abs(value) <= 550;
  if (field === 'cloudCover' || field === 'icingProbability') return value >= 0 && value <= 100;
  if (field === 'icingSeverity') return Number.isInteger(value) && value >= 0 && value <= 4;
  if (field === 'sldPotential') return value >= 0 && value <= 1;
  return value >= -1500 && value <= 100000;
}
