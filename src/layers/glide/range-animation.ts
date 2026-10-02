import { project, type Point } from '../../core/geo/route-corridor';
import { mergeFootprints } from './geometry';
import type { GlideRange } from './types';

type LocatedRange = { range: GlideRange; origin: Point };
const DURATION_MS = 600;
const FRAME_MS = 1000 / 30;
const TAU = 2 * Math.PI;
// Retargeting must not feed every clipped vertex back into the next transition.
// Fixed bearings bound the animated mesh independently of the number of fixes.
const BEARINGS = Array.from({ length: 128 }, (_, index) => index * TAU / 128);
const cross = (a: Point, b: Point) => a[0] * b[1] - a[1] * b[0];

/** Complete, single-world star outlines only. Unknown sectors, holes, zero
 * ranges and world splits are published directly rather than bridged by motion. */
function boundary({ range, origin }: LocatedRange) {
  const polygons = range.area.features[0]?.geometry.coordinates;
  const paths = range.line.features[0]?.geometry.coordinates;
  if (range.incomplete || range.area.features.length !== 1 || polygons?.length !== 1 || polygons[0]?.length !== 1
    || range.line.features.length !== 1 || paths?.length !== 1) return;
  const path = paths[0]!, first = path[0], last = path.at(-1);
  if (!first || !last || first[0] !== last[0] || first[1] !== last[1]) return;
  const center = project(origin);
  const polygon = polygons[0]![0]!.map(point => project(point as Point));
  const vertices = polygon.slice(0, -1).map(point => {
    const offset: Point = [point[0] - center[0], point[1] - center[1]];
    return { offset, angle: (Math.atan2(offset[1], offset[0]) + TAU) % TAU };
  }).sort((a, b) => a.angle - b.angle);
  if (vertices.length < 3 || vertices.length > 4096 || vertices.some((vertex, i) =>
    cross(vertex.offset, vertices[(i + 1) % vertices.length]!.offset) <= 0)) return;
  return { center, polygon, vertices };
}

/** Interpolate corresponding bearings, then intersect with the NEW terrain
 * footprint. Contractions take effect immediately; expansion eases into place.
 * Every intermediate fill and outline stays inside the latest calculated area. */
export function rangeTransition(from: LocatedRange, to: LocatedRange): ((progress: number) => GlideRange) | undefined {
  const a = boundary(from), b = boundary(to);
  if (!a || !b) return;
  const sample = (shape: typeof a, angle: number): Point => {
    const index = shape.vertices.findIndex(vertex => vertex.angle > angle);
    const right = index < 0 ? 0 : index, left = (right + shape.vertices.length - 1) % shape.vertices.length;
    const p = shape.vertices[left]!.offset, q = shape.vertices[right]!.offset;
    const direction: Point = [Math.cos(angle), Math.sin(angle)];
    const radius = cross(p, q) / cross(direction, [q[0] - p[0], q[1] - p[1]]);
    return [shape.center[0] + radius * direction[0], shape.center[1] + radius * direction[1]];
  };
  const start = BEARINGS.map(angle => sample(a, angle)), end = BEARINGS.map(angle => sample(b, angle));
  return progress => {
    if (progress >= 1) return to.range;
    const t = Math.max(0, progress);
    const ring: Point[] = start.map((point, i) => [point[0] + (end[i]![0] - point[0]) * t, point[1] + (end[i]![1] - point[1]) * t]);
    ring.push(ring[0]!);
    const area = mergeFootprints([[ring]], [[b.polygon]]);
    return { ...to.range, area, line: { type: 'FeatureCollection', features: area.features.length ? [{
      type: 'Feature', properties: {}, geometry: { type: 'MultiLineString',
        coordinates: area.features.flatMap(feature => feature.geometry.coordinates.flat()) },
    }] : [] } };
  };
}

/** A bounded transition per new result, with backpressure from MapLibre's
 * source workers. No terrain calculations, recurring timers or idle frames. */
export function createRangeAnimation(write: (range: GlideRange) => Promise<unknown>) {
  let displayed: LocatedRange | undefined;
  let animation: { target: LocatedRange; sample: (t: number) => GlideRange; start: number } | undefined;
  let frame: number | undefined, busy = false, revision = 0, lastFrame = -Infinity;
  const cancelFrame = () => { if (frame !== undefined) cancelAnimationFrame(frame); frame = undefined; };
  const schedule = () => { if (animation && !busy) frame ??= requestAnimationFrame(draw); };
  const draw = () => {
    frame = undefined;
    if (!animation || busy) return;
    const time = performance.now(), progress = Math.min(1, (time - animation.start) / DURATION_MS);
    if (progress < 1 && time - lastFrame < FRAME_MS) { schedule(); return; }
    const range = animation.sample(progress), version = revision;
    displayed = { ...animation.target, range };
    if (progress === 1) animation = undefined;
    lastFrame = time; busy = true;
    void write(range).catch(() => {
      if (version === revision) { animation = undefined; displayed = undefined; }
    }).finally(() => { busy = false; schedule(); });
  };
  return {
    set(range: GlideRange, origin: Point, animate: boolean) {
      revision++; cancelFrame();
      const target = { range, origin };
      const sample = animate && displayed ? rangeTransition(displayed, target) : undefined;
      animation = { target, sample: sample ?? (() => range), start: performance.now() - (sample ? 0 : DURATION_MS) };
      draw();
    },
    finish() {
      if (!animation) return;
      cancelFrame(); animation.start = performance.now() - DURATION_MS; draw();
    },
    reset() { revision++; cancelFrame(); animation = undefined; displayed = undefined; },
  };
}
