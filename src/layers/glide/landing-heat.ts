import type { Bounds } from '@zlayer/contracts';
import { distanceToSegment, nmPerWorldUnit, project, unproject, type Point, type Segment } from '../../core/geo/route-corridor';
import { GLIDE_CORRIDOR_NM } from './coverage';
import type { LandingScope } from './landing-sources';
import { prepareHeatScope } from './landing-scope';
import type { LandingArea, LandingShard } from './landing-data';

/** A small, immutable raster of screened ground, independent of routes and cameras. */
export type LandingHeat = { density?: boolean; scope?: LandingScope | undefined; extent: Bounds; width: number; height: number; cells: Uint8Array; flags: number };
export type LandingHeatImage = { bounds: Bounds; width: number; height: number; rgba: Uint8ClampedArray; shadedCells: number };
const MAX_SIZE = 512, HEADER = 48;

export function prepareLandingHeat(areas: LandingArea[], shard: LandingShard): LandingHeat {
  const nw = project([shard.bounds[0], shard.bounds[3]]), se = project([shard.bounds[2], shard.bounds[1]]);
  const dx = se[0] - nw[0], dy = se[1] - nw[1], step = Math.max(1 / 262144, dx / MAX_SIZE, dy / MAX_SIZE);
  const width = Math.min(MAX_SIZE, Math.max(1, Math.ceil(dx / step))), height = Math.min(MAX_SIZE, Math.max(1, Math.ceil(dy / step)));
  const canvas = new OffscreenCanvas(width, height), context = canvas.getContext('2d', { willReadFrequently: true })!;
  // Separate fills retain holes. Preferred ground wins where original polygons overlap.
  for (const tier of [1, 2]) {
    context.fillStyle = tier === 2 ? '#00ff00' : '#ff0000';
    for (const area of areas) if (area.tier === tier) {
      context.beginPath();
      for (const ring of area.polygon) {
        ring.forEach(([x, y], i) => {
          const px = (x - nw[0]) / dx * width, py = (y - nw[1]) / dy * height;
          if (i === 0) context.moveTo(px, py); else context.lineTo(px, py);
        });
        context.closePath();
      }
      context.fill('evenodd');
    }
  }
  const pixels = context.getImageData(0, 0, width, height).data, cells = new Uint8Array(width * height);
  for (let i = 0; i < cells.length; i++) if (pixels[i * 4 + 3]! >= 128) cells[i] = pixels[i * 4 + 1]! > pixels[i * 4]! ? 2 : 1;
  canvas.width = canvas.height = 1;
  return { extent: [nw[0], nw[1], se[0], se[1]], width, height, cells, flags: areas.reduce((flags, area) => flags | area.flags, 0) };
}

export function encodeLandingHeat(heat: LandingHeat): ArrayBuffer {
  const bytes = new ArrayBuffer(HEADER + heat.cells.length), view = new DataView(bytes);
  view.setUint32(0, 1, true); view.setUint32(4, heat.flags, true);
  heat.extent.forEach((n, i) => view.setFloat64(8 + 8 * i, n, true));
  view.setUint32(40, heat.width, true); view.setUint32(44, heat.height, true);
  new Uint8Array(bytes, HEADER).set(heat.cells); return bytes;
}

export function decodeLandingHeat(bytes: ArrayBuffer): LandingHeat {
  if (bytes.byteLength < HEADER) throw new Error('Incomplete landing shading cache');
  const view = new DataView(bytes), width = view.getUint32(40, true), height = view.getUint32(44, true);
  const extent = Array.from({ length: 4 }, (_, i) => view.getFloat64(8 + i * 8, true)) as Bounds;
  const flags = view.getUint32(4, true), cells = new Uint8Array(bytes, HEADER);
  if (view.getUint32(0, true) !== 1 || !width || !height || width > MAX_SIZE || height > MAX_SIZE
    || cells.length !== width * height || flags > 2047 || !extent.every(Number.isFinite)
    || extent[0] >= extent[2] || extent[1] >= extent[3] || !cells.every(n => n <= 2)) throw new Error('Invalid landing shading cache');
  return { extent, width, height, cells, flags };
}

/** Screen-sized density cells, using union samples rather than counts of overlapping patches. */
export function landingHeatFrame(bounds: Bounds, zoom: number) {
  const east = bounds[2] < bounds[0] ? bounds[2] + 360 : bounds[2];
  const nw = project([bounds[0], bounds[3]]), se = project([east, bounds[1]]);
  const step = 2 ** Math.ceil(Math.log2(Math.max(4 / (512 * 2 ** Math.floor(zoom)), (se[0] - nw[0]) / 384, (se[1] - nw[1]) / 384)));
  const left = Math.floor(nw[0] / step) * step, top = Math.floor(nw[1] / step) * step;
  const width = Math.max(1, Math.ceil((se[0] - left) / step)), height = Math.max(1, Math.ceil((se[1] - top) / step));
  return { left, top, width, height, step };
}

export type LandingHeatFrame = ReturnType<typeof landingHeatFrame>;

/** Keep the same geographic cell size while amortizing small camera moves.
 * At most 32 extra cells per edge: 449² cells, regardless of display density. */
export function bufferedLandingHeatFrame(view: LandingHeatFrame, previous?: LandingHeatFrame): LandingHeatFrame {
  if (previous && previous.step === view.step && view.left >= previous.left && view.top >= previous.top
    && view.left + view.width * view.step <= previous.left + previous.width * previous.step
    && view.top + view.height * view.step <= previous.top + previous.height * previous.step) return previous;
  const x = Math.min(32, Math.ceil(view.width / 8)), y = Math.min(32, Math.ceil(view.height / 8));
  return { left: view.left - x * view.step, top: view.top - y * view.step,
    width: view.width + 2 * x, height: view.height + 2 * y, step: view.step };
}

export function landingHeatBounds({ left, top, width, height, step }: LandingHeatFrame): Bounds {
  const a = unproject([left, top]), b = unproject([left + width * step, top + height * step]);
  return [a[0], b[1], b[0], a[1]];
}

export function landingHeatImage(heats: LandingHeat[], bounds: Bounds, zoom: number, segments: Segment[]): LandingHeatImage {
  return composeLandingHeat(heats, landingHeatFrame(bounds, zoom), segments);
}

export function composeLandingHeat(heats: LandingHeat[], frame: LandingHeatFrame, segments: Segment[]): LandingHeatImage {
  const { left, top, width, height, step } = frame;
  const rgba = new Uint8ClampedArray(width * height * 4), center = left + width * step / 2;
  // Each bit is one of the existing 4×4 union samples. Scatter only over each
  // source's extent, instead of searching every source for every output cell.
  const coveredSamples = new Uint16Array(width * height), preferredSamples = new Uint16Array(width * height);
  // Accumulate byte samples exactly, then normalize once. Besides allowing the
  // uniform-cell shortcut, this keeps tier ties independent of rounding/order.
  const densities = new Uint32Array(width * height), preferredDensities = new Uint32Array(width * height);
  // Adjacent cells share corner checks. Zero means unchecked, not outside.
  const corners = new Uint8Array((width + 1) * (height + 1)), admitted = new Uint8Array(width * height);
  const scales = Float64Array.from({ length: height + 1 }, (_, y) => nmPerWorldUnit(top + y * step));
  const inside = (x: number, y: number) => {
    const index = y * (width + 1) + x;
    if (!corners[index]) {
      const point: Point = [left + x * step, top + y * step];
      corners[index] = segments.some(segment => distanceToSegment(point, segment) * scales[y]! <= GLIDE_CORRIDOR_NM) ? 2 : 1;
    }
    return corners[index] === 2;
  };
  for (const heat of heats) {
    const inScope = prepareHeatScope(heat.scope, heat.extent);
    const [w, n, e, s] = heat.extent, shift = Math.round(center - (w + e) / 2);
    const xStart = Math.max(0, Math.floor((w + shift - left) / step)), xEnd = Math.min(width, Math.ceil((e + shift - left) / step));
    const yStart = Math.max(0, Math.floor((n - top) / step)), yEnd = Math.min(height, Math.ceil((s - top) / step));
    if (xStart >= xEnd || yStart >= yEnd) continue;
    const columns = new Int32Array((xEnd - xStart) * 4), rows = new Int32Array((yEnd - yStart) * 4);
    for (let x = xStart; x < xEnd; x++) for (let sx = 0; sx < 4; sx++) {
      const wx = left + x * step + (sx + .5) / 4 * step;
      columns[(x - xStart) * 4 + sx] = Math.floor((wx - shift - w) / (e - w) * heat.width);
    }
    for (let y = yStart; y < yEnd; y++) for (let sy = 0; sy < 4; sy++) {
      const wy = top + y * step + (sy + .5) / 4 * step;
      rows[(y - yStart) * 4 + sy] = Math.floor((wy - n) / (s - n) * heat.height);
    }
    for (let y = yStart; y < yEnd; y++) for (let x = xStart; x < xEnd; x++) {
      const index = y * width + x;
      if (preferredSamples[index] === 0xffff) continue;
      // Keep every corner inside the route corridor before sampling any sources.
      if (!admitted[index]) admitted[index] = inside(x, y) && inside(x + 1, y) && inside(x + 1, y + 1) && inside(x, y + 1) ? 2 : 1;
      if (admitted[index] !== 2) continue;
      let covered = coveredSamples[index]!, preferred = preferredSamples[index]!;
      const column = (x - xStart) * 4, row = (y - yStart) * 4;
      const px0 = columns[column]!, py0 = rows[row]!;
      // Published fractions already summarize ground area. For interior cells
      // whose 16 samples hit the same pixel, read that fraction only once.
      // Scope edges, mixed preferred masks and resampling retain exact samples.
      if (heat.density && !inScope && !preferred && px0 >= 0 && px0 < heat.width && py0 >= 0 && py0 < heat.height
        && px0 === columns[column + 3] && py0 === rows[row + 3]) {
        const i = (py0 * heat.width + px0) * 3;
        preferredDensities[index]! += heat.cells[i]! * 16;
        densities[index]! += (heat.cells[i]! + heat.cells[i + 1]!) * 16;
        continue;
      }
      for (let sy = 0; sy < 4; sy++) {
        const py = rows[(y - yStart) * 4 + sy]!;
        if (py < 0 || py >= heat.height) continue;
        for (let sx = 0; sx < 4; sx++) {
          const bit = 1 << (sy * 4 + sx);
          if (preferred & bit) continue;
          const px = columns[(x - xStart) * 4 + sx]!;
          if (px < 0 || px >= heat.width) continue;
          if (inScope && !inScope(left + (x + (sx + .5) / 4) * step, top + (y + (sy + .5) / 4) * step)) continue;
          if (heat.density) {
            const i = (py * heat.width + px) * 3;
            preferredDensities[index]! += heat.cells[i]!;
            densities[index]! += heat.cells[i]! + heat.cells[i + 1]!;
            continue;
          }
          const tier = heat.cells[py * heat.width + px]!;
          if (tier) covered |= bit;
          if (tier === 2) preferred |= bit;
        }
      }
      coveredSamples[index] = covered; preferredSamples[index] = preferred;
    }
  }
  let shadedCells = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * width + x, samples = coveredSamples[index]!;
    if (!samples && !densities[index]) continue;
    const covered = Math.min(255 * 16, sampleCount(samples) * 255 + densities[index]!);
    const preferred = Math.min(covered, sampleCount(preferredSamples[index]!) * 255 + preferredDensities[index]!);
    const green = preferred > covered / 2, i = index * 4;
    // Preserve tier identity: blending complementary hues produces a gray wash on charts.
    rgba[i] = green ? 83 : 162; rgba[i + 1] = green ? 229 : 59; rgba[i + 2] = green ? 45 : 255;
    rgba[i + 3] = Math.round(64 + 160 * Math.sqrt(covered / (255 * 16))); shadedCells++;
  }
  return { bounds: landingHeatBounds(frame), width, height, rgba, shadedCells };
}

function sampleCount(bits: number): number {
  bits -= (bits >>> 1) & 0x5555;
  bits = (bits & 0x3333) + ((bits >>> 2) & 0x3333);
  bits = (bits + (bits >>> 4)) & 0x0f0f;
  return (bits + (bits >>> 8)) & 0x1f;
}
