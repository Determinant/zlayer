import { GRID_MISSING, type AwcGridField, type AwcGridManifest, type AwcGridFrame } from '@zlayer/contracts';
import type { ForecastFrame, ForecastManifest } from './native-source';
export { gridKey } from './identity';
import { currentFrame } from '../time';
import { windFrames } from './wind-levels';
import { readBand, type GridBand } from './packed';
import { validGridValue } from './values';
export { isGridSentinel, validGridValue } from './values';

type GridDescriptor = { manifest: ForecastManifest; frame: ForecastFrame; byteLength: number; endpoint?: string };
export type DenseGrid = GridDescriptor & { values: Float32Array };
export type DecodedGrid = DenseGrid | GridDescriptor & { bands: readonly GridBand[] };
/** A different timeline tick may still use this same hourly frame. */
export function gridMatchesTime(data: DecodedGrid, time: number): boolean {
  const times = ('windAltitude' in data.frame ? windFrames(data.manifest, data.frame.windAltitude)
    : data.manifest.frames.filter(frame => frame.altitudeFtMsl === data.frame.altitudeFtMsl &&
      frame.pressureHpa === data.frame.pressureHpa)).map(frame => frame.validTime);
  return currentFrame(times, time, data.manifest.cadenceMs) === data.frame.validTime;
}
/** Gzip is file encoding, not HTTP Content-Encoding. Bound output before allocation. */
export async function decodeGrid(bytes: ArrayBuffer, manifest: AwcGridManifest, frame: AwcGridFrame, signal: AbortSignal): Promise<DenseGrid> {
  const values = await decodeVerifiedValues(bytes, manifest, frame, signal);
  return { manifest, frame, values, byteLength: values.buffer.byteLength };
}

export async function decodeVerifiedValues(bytes: ArrayBuffer, manifest: Pick<ForecastManifest, 'grid' | 'fields'>,
  frame: Pick<AwcGridFrame, 'bytes' | 'decodedBytes' | 'sha256'>, signal: AbortSignal): Promise<Float32Array<ArrayBuffer>> {
  signal.throwIfAborted();
  if (bytes.byteLength !== frame.bytes) throw new Error('Forecast file size mismatch');
  if (frame.decodedBytes !== 16 + manifest.grid.width * manifest.grid.height * manifest.fields.length * 4) throw new Error('Forecast decoded size mismatch');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  if ([...digest].map(v => v.toString(16).padStart(2, '0')).join('') !== frame.sha256.toLowerCase()) throw new Error('Forecast file checksum mismatch');
  return decodeValues(bytes, manifest, signal);
}

/** Only geometry and field order cross the worker boundary, never a full forecast catalog. */
export async function decodeValues(bytes: ArrayBuffer, manifest: Pick<ForecastManifest, 'grid' | 'fields'>, signal: AbortSignal): Promise<Float32Array<ArrayBuffer>> {
  signal.throwIfAborted();
  const output = new Uint8Array(16 + manifest.grid.width * manifest.grid.height * manifest.fields.length * 4);
  // Avoid Blob I/O: WebKit can reject even memory-backed Blob reads while offline.
  // Bound compressed pulls as well as decoded output for every browser.
  let compressedOffset = 0;
  const compressed = new Uint8Array(bytes);
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({ pull(controller) {
    if (compressedOffset === compressed.length) { controller.close(); return; }
    const end = Math.min(compressed.length, compressedOffset + 64 * 1024);
    controller.enqueue(compressed.subarray(compressedOffset, end)); compressedOffset = end;
  } });
  const reader = stream.pipeThrough(new DecompressionStream('gzip')).getReader();
  let offset = 0, complete = false;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) { complete = true; break; }
      if (offset + value.byteLength > output.length) throw new Error('Forecast exceeds decoded size');
      output.set(value, offset); offset += value.byteLength;
    }
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (offset !== output.length || new TextDecoder().decode(output.subarray(0, 8)) !== 'ZAWCGRID') throw new Error('Invalid forecast grid header');
  const view = new DataView(output.buffer), { width, height } = manifest.grid;
  if (view.getUint16(8, true) !== 1 || view.getUint16(10, true) !== width || view.getUint16(12, true) !== height ||
    view.getUint16(14, true) !== manifest.fields.length) throw new Error('Forecast grid metadata mismatch');
  const values = new Float32Array(output.buffer, 16), count = width * height;
  // Explicit byte order, including hosts whose native endianness differs.
  if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) {
    for (let i = 0; i < values.length; i++) values[i] = view.getFloat32(16 + i * 4, true);
  }
  for (let band = 0; band < manifest.fields.length; band++) {
    for (let i = 0; i < count; i++) if (!validGridValue(manifest.fields[band]!, values[band * count + i]!)) throw new Error('Forecast grid has an invalid value');
    signal.throwIfAborted();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return values;
}

const mercatorY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
export function gridCell(manifest: Pick<AwcGridManifest, 'grid'>, longitude: number, latitude: number): number | undefined {
  const { width, height, bounds: [west, south, east, north] } = manifest.grid;
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || longitude < west || longitude >= east || latitude <= south || latitude > north) return undefined;
  const x = Math.floor((longitude - west) / (east - west) * width);
  const y = Math.floor((mercatorY(north) - mercatorY(latitude)) / (mercatorY(north) - mercatorY(south)) * height);
  return Math.min(height - 1, y) * width + x;
}
export function gridValue(grid: DecodedGrid, field: AwcGridField, cell: number): number {
  return gridReader(grid, field)(cell);
}
export function gridReader(grid: DecodedGrid, field: AwcGridField): (cell: number) => number {
  const band = grid.manifest.fields.indexOf(field);
  if (band < 0) return () => GRID_MISSING;
  if ('bands' in grid) return readBand(grid.bands[band]!);
  const offset = band * grid.manifest.grid.width * grid.manifest.grid.height;
  return cell => grid.values[offset + cell]!;
}
