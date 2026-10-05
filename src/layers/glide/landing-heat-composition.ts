import clipping, { type MultiPolygon } from 'polygon-clipping';
import type { Bounds } from '@zlayer/contracts';
import type { Point, Segment } from '../../core/geo/route-corridor';
import { routeMask } from './coverage';
import { createLandingRowSweep } from './landing-geometry';
import { scopedLandingMask } from './landing-scope';
import type { LandingHeat, LandingHeatFrame, LandingHeatImage } from './landing-heat';

const rectangle = ([w, n, e, s]: Bounds): MultiPolygon => [[[[w, n], [e, n], [e, s], [w, s], [w, n]]]];
type Event = { x: number; covered: number; preferred: number; delta: number };

/** Eight bitsets keep maximum density lookup constant-time, even across empty
 * spans. Walking all 255 byte values per pixel makes sparse rasters expensive. */
class DensityUnion {
  counts = new Uint16Array(256);
  words = new Uint32Array(8);
  occupied = 0;
  change(value: number, delta: number) {
    if (!value) return;
    const word = value >>> 5, bit = 1 << (value & 31);
    this.counts[value]! += delta;
    if (this.counts[value]) { this.words[word]! |= bit; this.occupied |= 1 << word; }
    else { this.words[word]! &= ~bit; if (!this.words[word]) this.occupied &= ~(1 << word); }
  }
  maximum() {
    const word = 31 - Math.clz32(this.occupied);
    return word < 0 ? 0 : word * 32 + 31 - Math.clz32(this.words[word]!);
  }
}

/** Integrate the resident raster field, rather than probing a few points in each
 * output cell. Every contributing source pixel survives downsampling. Scan-line
 * unions count overlapping legacy pixels once and preserve preferred precedence.
 * Only one row of events/accumulators is live, independently of the zoom ratio. */
export function composeLandingDensity(heats: LandingHeat[], frame: LandingHeatFrame, segments: Segment[]) {
  const { left, top, width, height, step } = frame, right = left + width * step, bottom = top + height * step;
  const coverage = new Float32Array(width * height), preference = new Float32Array(width * height);
  const corridor = routeMask(segments, [[left, top], [right, top], [right, bottom], [left, bottom]]);
  const cuts = new Set<number>(Array.from({ length: height + 1 }, (_, y) => top + y * step));
  const grids = heats.flatMap(heat => {
    const [w, n, e, s] = heat.extent, shift = Math.round((left + right - w - e) / 2);
    if (e + shift <= left || w + shift >= right || s <= top || n >= bottom) return [];
    const box = rectangle(heat.extent);
    let mask = scopedLandingMask(box, heat.scope);
    if (heat.exclude?.length) mask = clipping.difference(mask, heat.exclude.flatMap(rectangle));
    if (!mask.length || !corridor.length) return [];
    const localCorridor = corridor.map(p => p.map(r => r.map(([x, y]) => [x - shift, y] as Point)));
    mask = clipping.intersection(mask, localCorridor);
    const dy = (s - n) / heat.height, dx = (e - w) / heat.width;
    for (let y = 0; y <= heat.height; y++) {
      const at = n + y * dy;
      if (at > top && at < bottom) cuts.add(at);
    }
    // Include ownership boundaries even when a narrow region lies inside one
    // source row. Polygon edges are interpolated at each integration strip.
    if (mask !== box) for (const polygon of mask) for (const ring of polygon) for (const [, y] of ring) {
      if (y > top && y < bottom) cuts.add(y);
    }
    return [{ heat, w: w + shift, n, e: e + shift, s, dx, dy, shift,
      spans: mask === box ? undefined : createLandingRowSweep(mask) }];
  });
  const rows = [...cuts].sort((a, b) => a - b);
  const covered = new Float64Array(width), preferred = new Float64Array(width);
  // Ordinary published tiles are disjoint. Integrate their spans directly;
  // overlapping legacy summaries and parent/child mosaics use the union sweep.
  const overlapping = grids.map((a, i) => grids.some((b, j) => i !== j && a.w < b.e && a.e > b.w && a.n < b.s && a.s > b.n));
  const canCover = grids.map((a, i) => grids.some((b, j) => i !== j && a.w <= b.w && a.e >= b.e && a.n <= b.n && a.s >= b.s));
  const coverageUnion = new DensityUnion(), preferredUnion = new DensityUnion();
  let outputRow = -1;
  const rowLeft = left, rowRight = right;
  const publishRow = () => {
    if (outputRow < 0) return;
    coverage.set(covered, outputRow * width); preference.set(preferred, outputRow * width);
    covered.fill(0); preferred.fill(0);
  };
  for (let strip = 1; strip < rows.length; strip++) {
    const north = rows[strip - 1]!, south = rows[strip]!, y = (north + south) / 2;
    const row = Math.min(height - 1, Math.floor((y - top) / step));
    if (row !== outputRow) { publishRow(); outputRow = row; }
    if (rowLeft >= rowRight) continue;
    const weight = (south - north) / step;
    const addSpan = (a: number, b: number, total: number, green: number) => {
      const first = Math.max(0, Math.floor((a - left) / step)), last = Math.min(width, Math.ceil((b - left) / step));
      for (let x = first; x < last; x++) {
        const fraction = (Math.min(b, left + (x + 1) * step) - Math.max(a, left + x * step)) / step * weight;
        covered[x]! += total * fraction; preferred[x]! += green * fraction;
      }
    };
    const events: Event[] = [];
    let opaque: Point[] = [];
    for (let g = 0; g < grids.length; g++) {
      const grid = grids[g]!;
      if (y < grid.n || y >= grid.s) continue;
      const extentLeft = Math.max(rowLeft, grid.w), extentRight = Math.min(rowRight, grid.e);
      if (extentLeft >= extentRight || opaque.some(([a, b]) => a <= extentLeft && b >= extentRight)) continue;
      const { heat, w, dx } = grid;
      const greenSpans: Point[] = [];
      const sourceRow = Math.min(heat.height - 1, Math.floor((y - grid.n) / grid.dy));
      const spans = grid.spans ? grid.spans(y).map(([a, b]) => [a + grid.shift, b + grid.shift] as Point) : [[w, grid.e]];
      for (const [start, end] of spans) {
        const a = Math.max(rowLeft, start!), b = Math.min(rowRight, end!);
        if (a >= b) continue;
        const first = Math.max(0, Math.floor((a - w) / dx)), last = Math.min(heat.width, Math.ceil((b - w) / dx));
        let runStart = a, runCovered = -1, runPreferred = -1;
        const flush = (at: number) => {
          if (runCovered > 0 && at > runStart) {
            if (overlapping[g]) events.push({ x: runStart, covered: runCovered, preferred: runPreferred, delta: 1 },
              { x: at, covered: runCovered, preferred: runPreferred, delta: -1 });
            else addSpan(runStart, at, runCovered, runPreferred);
            if (canCover[g] && runPreferred === 255) greenSpans.push([runStart, at]);
          }
        };
        for (let x = first; x < last; x++) {
          const index = sourceRow * heat.width + x, tier = heat.cells[index]!;
          const green = heat.density ? heat.cells[index * 3]! : tier === 2 ? 255 : 0;
          const total = heat.density ? green + heat.cells[index * 3 + 1]! : tier ? 255 : 0;
          if (total !== runCovered || green !== runPreferred) {
            const at = Math.max(a, w + x * dx); flush(at);
            runStart = at; runCovered = total; runPreferred = green;
          }
        }
        flush(b);
      }
      // Fully preferred ground cannot be changed by another overlapping input.
      // Union complete spans before admitting more grids, especially duplicate
      // legacy summaries. Gaps and partial numeric fractions never trigger this.
      if (greenSpans.length) {
        const spans = [...opaque, ...greenSpans].sort((a, b) => a[0] - b[0]);
        opaque = [];
        for (const span of spans) {
          const previous = opaque.at(-1);
          if (previous && span[0] <= previous[1]) previous[1] = Math.max(previous[1], span[1]);
          else opaque.push([...span]);
        }
      }
    }
    events.sort((a, b) => a.x - b.x);
    let maximum = 0, greenMaximum = 0, previous = left;
    for (const event of events) {
      if (maximum && event.x > previous) addSpan(previous, event.x, maximum, greenMaximum);
      coverageUnion.change(event.covered, event.delta); preferredUnion.change(event.preferred, event.delta);
      maximum = coverageUnion.maximum(); greenMaximum = preferredUnion.maximum();
      previous = event.x;
    }
  }
  publishRow();
  return { width, height, coverage, preference };
}

export type LandingDensity = ReturnType<typeof composeLandingDensity>;
export function colorLandingDensity({ width, height, coverage, preference }: LandingDensity): Omit<LandingHeatImage, 'bounds'> {
  const rgba = new Uint8ClampedArray(width * height * 4);
  let shadedCells = 0;
  for (let cell = 0; cell < coverage.length; cell++) {
    const covered = coverage[cell]!;
    if (covered <= 1e-9) continue;
    const green = preference[cell]! > covered / 2 + 1e-7, i = cell * 4;
    rgba[i] = green ? 83 : 162; rgba[i + 1] = green ? 229 : 59; rgba[i + 2] = green ? 45 : 255;
    rgba[i + 3] = Math.round(64 + 160 * Math.sqrt(Math.min(1, covered / 255))); shadedCells++;
  }
  return { width, height, rgba, shadedCells };
}

export function composeLandingHeatCells(heats: LandingHeat[], frame: LandingHeatFrame, segments: Segment[]) {
  return colorLandingDensity(composeLandingDensity(heats, frame, segments));
}
