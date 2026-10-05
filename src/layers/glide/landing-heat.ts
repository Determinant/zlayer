import type { Bounds } from '@zlayer/contracts';
import { project } from '../../core/geo/route-corridor';
import type { LandingScope } from './landing-sources';
import type { LandingArea, LandingShard } from './landing-data';

/** A small, immutable raster of screened ground, independent of routes and cameras. */
export type LandingHeat = { density?: boolean; scope?: LandingScope | undefined; extent: Bounds; width: number; height: number; cells: Uint8Array; flags: number;
  /** Resident finer tiles own these rectangles in this grid's world copy. */
  exclude?: Bounds[] };
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

export type LandingHeatFrame = { left: number; top: number; width: number; height: number; step: number };
