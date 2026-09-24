import { AWC_GRID_FIELDS, type AwcGridField } from '@zlayer/contracts';
import { gridReader, type DecodedGrid } from './format';
import { gridPackedColorizer } from './presentation';
import type { GridViewport } from './viewport';

/** One candidate image; each visible model cell is colored once, then expanded. */
export async function rasterGrid(data: DecodedGrid, field: AwcGridField, sld: boolean, viewport: GridViewport, signal: AbortSignal): Promise<Uint8ClampedArray<ArrayBuffer>> {
  signal.throwIfAborted();
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  signal.throwIfAborted();
  const { width, height, pixelRatio, columns, rows } = viewport;
  const pixels = new Uint32Array(width * height), color = gridPackedColorizer(field);
  const read = gridReader(data, field);
  const hatch = sld && (AWC_GRID_FIELDS.icing as readonly string[]).includes(field) && field !== 'sldPotential';
  const readSld = hatch ? gridReader(data, 'sldPotential') : undefined;
  // Adjacent pixels sampling one model column share their base/SLD colors.
  const stops = [0];
  for (let x = 1; x < width; x++) if (columns[x] !== columns[x - 1]) stops.push(x);
  stops.push(width);
  const expand = stops.length - 1 < width / 2;
  const base = new Uint32Array(stops.length - 1), overlay = new Uint32Array(base.length);
  const phases = hatch ? Uint8Array.from({ length: width }, (_, x) => Math.floor(x / pixelRatio) % 7) : undefined;
  const drawnRows = new Int32Array(7).fill(-1);
  let modelRow = -1, deadline = performance.now() + 6;
  for (let y = 0; y < height; y++) {
    const row = rows[y]!, screenY = Math.floor(y / pixelRatio), phase = hatch ? screenY % 7 : 0;
    if (row !== modelRow) {
      drawnRows.fill(-1); modelRow = row;
      if (expand && hatch) for (let span = 0; span < base.length; span++) {
        const cell = row + columns[stops[span]!]!, value = read(cell);
        base[span] = color(value, 0, 0, undefined);
        overlay[span] = readSld ? color(value, 0, 0, readSld(cell)) : base[span]!;
      }
    }
    const offset = y * width, previous = drawnRows[phase]!;
    if (previous >= 0) pixels.copyWithin(offset, previous, previous + width);
    else {
      // At a broad extent, most pixels select different cells. The direct loop
      // avoids span bookkeeping when there is little to reuse.
      if (!expand) for (let x = 0; x < width; x++) {
        const cell = row + columns[x]!;
        pixels[offset + x] = color(read(cell),
          Math.floor(x / pixelRatio), screenY, readSld?.(cell));
      }
      else for (let span = 0; span < base.length; span++) {
        const from = stops[span]!, to = stops[span + 1]!;
        const plain = hatch ? base[span]! : color(read(row + columns[from]!), 0, 0, undefined);
        const striped = hatch ? overlay[span]! : plain;
        if (plain !== striped) for (let x = from; x < to; x++) pixels[offset + x] = (phases![x]! + phase) % 7 < 2 ? striped : plain;
        else if (to === from + 1) pixels[offset + from] = plain;
        else pixels.fill(plain, offset + from, offset + to);
      }
      drawnRows[phase] = offset;
    }
    if ((y & 7) === 7 && y + 1 < height && performance.now() >= deadline) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      signal.throwIfAborted(); deadline = performance.now() + 6;
    }
  }
  signal.throwIfAborted();
  return new Uint8ClampedArray(pixels.buffer);
}
