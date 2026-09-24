import { GRID_BELOW_GROUND, GRID_MISSING, GRID_OUTSIDE } from '@zlayer/contracts';
import { isGridSentinel } from './format';
import { isWindAltitude, windPressure } from './wind-levels';

type Level = { pressure: number; logPressure: number; values: Float32Array };
const valid = (value: number) => Number.isFinite(value) && !isGridSentinel(value);

/** Two boundary levels plus one output, never an all-altitude cube. Components
 * are earth-relative before interpolation. Missing brackets never extrapolate. */
export class WindInterpolation {
  private lower?: Level;
  private upper?: Level;
  private readonly count: number;
  private readonly msl: boolean;
  private readonly target: number;
  constructor(altitude: number, readonly values: Float32Array, private readonly terrain?: Float32Array) {
    this.count = values.length / 4;
    if (!isWindAltitude(altitude) || !Number.isInteger(this.count) || !this.count || terrain && terrain.length !== this.count) throw new Error('Invalid wind interpolation geometry');
    this.msl = altitude < 18000;
    this.target = this.msl ? altitude : -Math.log(windPressure(altitude));
    values.fill(GRID_MISSING);
    if (terrain && this.msl) for (let i = 0; i < this.count; i++) {
      if (Number.isFinite(terrain[i]) && altitude <= terrain[i]! / 0.3048) this.fill(i, GRID_BELOW_GROUND);
    }
  }
  private eligible(i: number) {
    return !this.terrain || Number.isFinite(this.terrain[i]) && (!this.msl || this.target > this.terrain[i]! / 0.3048);
  }
  private fill(i: number, value: number) { for (let band = 0; band < 4; band++) this.values[band * this.count + i] = value; }
  private coordinate(level: Level, i: number) { return this.msl ? level.values[i]! : level.logPressure; }
  private interpolate(lower: Level, upper: Level) {
    const target = this.target;
    // Flight-level weights are constant across the whole grid. MSL weights use
    // each cell's heights; neither path computes logarithms inside the cell loop.
    const pressureWeight = !this.msl && lower !== upper ? (target - lower.logPressure) / (upper.logPressure - lower.logPressure) : 0;
    for (let i = 0; i < this.count; i++) {
      // Expanding the search for other cells cannot replace a resolved bracket
      // or bridge a missing component with a more distant pressure level.
      if (valid(this.values[i]!) || this.values[i] === GRID_OUTSIDE) continue;
      if (lower.values[i] === GRID_OUTSIDE || upper.values[i] === GRID_OUTSIDE) { this.fill(i, GRID_OUTSIDE); continue; }
      if (!this.eligible(i)) continue;
      const low = this.coordinate(lower, i), high = this.coordinate(upper, i);
      // At an exact level, an unavailable neighbor cannot invalidate that sample.
      // Check this before range/order comparisons with a missing height sentinel.
      const exact = target === low ? lower : target === high ? upper : undefined;
      if (exact) {
        if (valid(exact.values[i]!)) for (let band = 0; band < 4; band++) this.values[band * this.count + i] = exact.values[band * this.count + i]!;
        else this.fill(i, isGridSentinel(exact.values[i]!) ? exact.values[i]! : GRID_MISSING);
        continue;
      }
      if (target < low || target > high) continue;
      if (lower.values[i] === GRID_BELOW_GROUND && upper.values[i] === GRID_BELOW_GROUND) { this.fill(i, GRID_BELOW_GROUND); continue; }
      if (!valid(lower.values[i]!) || !valid(upper.values[i]!) || high <= low || upper.values[i]! <= lower.values[i]!) continue;
      const weight = this.msl ? (target - low) / (high - low) : pressureWeight;
      this.values[i] = this.msl ? target : lower.values[i]! + weight * (upper.values[i]! - lower.values[i]!);
      for (let band = 1; band < 4; band++) {
        const at = band * this.count + i, a = lower.values[at]!, b = upper.values[at]!;
        this.values[at] = valid(a) && valid(b) ? a + weight * (b - a) : GRID_MISSING;
      }
    }
  }
  add(pressure: number, values: Float32Array): { below: boolean; above: boolean } {
    if (!Number.isFinite(pressure) || pressure <= 0 || values.length !== this.values.length) throw new Error('Invalid wind interpolation level');
    const level = { pressure, logPressure: -Math.log(pressure), values };
    if (!this.lower || !this.upper) { this.lower = this.upper = level; this.interpolate(level, level); }
    else if (pressure > this.lower.pressure) { this.interpolate(level, this.lower); this.lower = level; }
    else if (pressure < this.upper.pressure) { this.interpolate(this.upper, level); this.upper = level; }
    else throw new Error('Wind interpolation levels must expand the bracket');
    let below = false, above = false;
    const target = this.target;
    for (let i = 0; i < this.count && !(below && above); i++) {
      if (!this.eligible(i) || valid(this.values[i]!) || this.values[i] === GRID_OUTSIDE) continue;
      const low = this.lower.values[i]!, high = this.upper.values[i]!;
      below ||= valid(low) && target < this.coordinate(this.lower, i);
      above ||= high === GRID_BELOW_GROUND || valid(high) && target > this.coordinate(this.upper, i);
    }
    return { below, above };
  }
}
