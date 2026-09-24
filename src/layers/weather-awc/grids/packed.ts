import { GRID_MISSING, type AwcGridField } from '@zlayer/contracts';
import { isGridSentinel, validGridValue } from './values';

export type GridBand = { values: Uint8Array<ArrayBuffer> | Int16Array<ArrayBuffer> | Float32Array<ArrayBuffer>; scale: number };
type Geometry = { grid: { width: number; height: number }; fields: readonly AwcGridField[] };
// Stable on-disk field IDs, independent of catalog/display ordering.
const fields: readonly AwcGridField[] = ['cloudCover', 'cloudBase', 'cloudTop', 'freezingLowest', 'freezingHighest',
  'icingProbability', 'icingSeverity', 'sldPotential', 'windHeight', 'windEast', 'windNorth', 'temperature'];
const magic = 'ZAWCPACK';
const align = (n: number) => Math.ceil(n / 4) * 4;
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const codec = (field: AwcGridField) => field === 'sldPotential' ? 2
  : ['cloudCover', 'icingProbability', 'icingSeverity'].includes(field) ? 1
  : ['temperature', 'windEast', 'windNorth'].includes(field) ? 4 : 3;
const scaleFor = (kind: number) => kind === 2 ? .01 : kind === 3 ? 10 : kind === 4 ? .1 : 1;
const sentinelStart = (kind: number) => kind <= 2 ? 252 : -32768;

/** Integer bands preserve the exact Float32 value, including all four sentinels.
 * Interpolated or otherwise nonrepresentable fields stay Float32, without rounding. */
export function packGrid(values: Float32Array, geometry: Geometry): ArrayBuffer {
  const count = geometry.grid.width * geometry.grid.height;
  if (values.length !== count * geometry.fields.length) throw new Error('Invalid grid sample count');
  const kinds = geometry.fields.map((field, band) => {
    let kind = codec(field);
    const scale = scaleFor(kind), end = (band + 1) * count;
    for (let i = band * count; i < end; i++) {
      const value = values[i]!;
      if (!validGridValue(field, value)) throw new Error('Invalid packed grid value');
      if (isGridSentinel(value)) continue;
      const n = Math.round(value / scale);
      if (!Object.is(Math.fround(n * scale), value) || (kind <= 2 ? n < 0 || n >= 252 : n < -32764 || n > 32767)) kind = 5;
    }
    return kind;
  });
  const header = 16 + kinds.length * 12;
  const size = header + kinds.reduce((n, kind) => n + align(count * (kind <= 2 ? 1 : kind <= 4 ? 2 : 4)), 0);
  const bytes = new ArrayBuffer(size), view = new DataView(bytes);
  new Uint8Array(bytes, 0, 8).set(new TextEncoder().encode(magic));
  view.setUint16(8, 1, true); view.setUint16(10, geometry.grid.width, true);
  view.setUint16(12, geometry.grid.height, true); view.setUint16(14, kinds.length, true);
  let offset = header;
  for (const [band, kind] of kinds.entries()) {
    const length = count * (kind <= 2 ? 1 : kind <= 4 ? 2 : 4), at = 16 + band * 12;
    view.setUint8(at, fields.indexOf(geometry.fields[band]!)); view.setUint8(at + 1, kind);
    view.setUint32(at + 4, offset, true); view.setUint32(at + 8, length, true);
    const scale = scaleFor(kind), sentinel = sentinelStart(kind);
    for (let i = 0; i < count; i++) {
      const value = values[band * count + i]!;
      const encoded = isGridSentinel(value) ? sentinel + value - GRID_MISSING : Math.round(value / scale);
      if (kind <= 2) view.setUint8(offset + i, encoded);
      else if (kind <= 4) view.setInt16(offset + i * 2, encoded, true);
      else view.setFloat32(offset + i * 4, value, true);
    }
    offset += align(length);
  }
  return bytes;
}

export function readBand(band: GridBand): (cell: number) => number {
  const { values, scale } = band;
  if (values instanceof Float32Array) return cell => values[cell]!;
  if (values instanceof Uint8Array) return cell => {
    const n = values[cell]!; return n >= 252 ? GRID_MISSING + n - 252 : Math.fround(n * scale);
  };
  return cell => {
    const n = values[cell]!; return n < -32764 ? GRID_MISSING + n + 32768 : Math.fround(n * scale);
  };
}

/** Parse authenticated bytes without expanding compact bands back to float bundles. */
export function unpackGrid(bytes: ArrayBuffer, geometry: Geometry): GridBand[] {
  return parseGrid(bytes, geometry, true);
}

/** Newly packed samples were just validated; build views without scanning twice. */
export function packGridBands(values: Float32Array, geometry: Geometry) {
  const buffer = packGrid(values, geometry);
  return { buffer, bands: parseGrid(buffer, geometry, false) };
}

function parseGrid(bytes: ArrayBuffer, geometry: Geometry, validateValues: boolean): GridBand[] {
  const { width, height } = geometry.grid, count = width * height, header = 16 + geometry.fields.length * 12;
  if (bytes.byteLength < header || bytes.byteLength > header + count * geometry.fields.length * 4 + 16 ||
    new TextDecoder().decode(new Uint8Array(bytes, 0, 8)) !== magic) throw new Error('Invalid packed grid header');
  const view = new DataView(bytes);
  if (view.getUint16(8, true) !== 1 || view.getUint16(10, true) !== width || view.getUint16(12, true) !== height ||
    view.getUint16(14, true) !== geometry.fields.length) throw new Error('Packed grid geometry mismatch');
  let offset = header;
  const bands = geometry.fields.map((field, band): GridBand => {
    const at = 16 + band * 12, kind = view.getUint8(at + 1), length = count * (kind <= 2 ? 1 : kind <= 4 ? 2 : 4);
    if (view.getUint8(at) !== fields.indexOf(field) || ![codec(field), 5].includes(kind) || view.getUint16(at + 2, true) !== 0 ||
      view.getUint32(at + 4, true) !== offset || view.getUint32(at + 8, true) !== length || offset + length > bytes.byteLength) {
      throw new Error('Invalid packed grid band');
    }
    // Typed views are zero-copy on little-endian devices; retain explicit file byte order elsewhere.
    const values = kind <= 2 ? new Uint8Array(bytes, offset, count) : kind <= 4
      ? littleEndian ? new Int16Array(bytes, offset, count) : Int16Array.from({ length: count }, (_, i) => view.getInt16(offset + i * 2, true))
      : littleEndian ? new Float32Array(bytes, offset, count) : Float32Array.from({ length: count }, (_, i) => view.getFloat32(offset + i * 4, true));
    const result = { values, scale: scaleFor(kind) }, read = readBand(result);
    if (validateValues) for (let i = 0; i < count; i++) if (!validGridValue(field, read(i))) throw new Error('Invalid packed grid value');
    offset += align(length);
    return result;
  });
  if (offset !== bytes.byteLength) throw new Error('Packed grid length mismatch');
  return bands;
}

export async function compressGrid(bytes: ArrayBuffer, signal?: AbortSignal): Promise<ArrayBuffer> {
  signal?.throwIfAborted();
  let offset = 0;
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({ pull(controller) {
    signal?.throwIfAborted();
    if (offset === bytes.byteLength) { controller.close(); return; }
    const end = Math.min(bytes.byteLength, offset + 64 * 1024);
    controller.enqueue(new Uint8Array(bytes, offset, end - offset)); offset = end;
  } });
  return new Response(source.pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
}

export async function inflatePacked(bytes: ArrayBuffer, geometry: Geometry): Promise<ArrayBuffer> {
  const max = 16 + geometry.fields.length * 12 + geometry.grid.width * geometry.grid.height * geometry.fields.length * 4 + 16;
  return inflateGridBytes(bytes, max);
}

export async function inflateGridBytes(bytes: ArrayBuffer, max: number, signal?: AbortSignal): Promise<ArrayBuffer> {
  signal?.throwIfAborted();
  let compressedOffset = 0;
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({ pull(controller) {
    signal?.throwIfAborted();
    if (compressedOffset === bytes.byteLength) { controller.close(); return; }
    const end = Math.min(bytes.byteLength, compressedOffset + 64 * 1024);
    controller.enqueue(new Uint8Array(bytes, compressedOffset, end - compressedOffset)); compressedOffset = end;
  } });
  const reader = source.pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = []; let size = 0, complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) { complete = true; break; }
      signal?.throwIfAborted();
      size += value.byteLength;
      if (size > max) throw new Error('Grid artifact exceeds decoded limit');
      chunks.push(value);
    }
  } finally {
    // WebKit can leave cancel() pending after a decompressor has already closed.
    // A completed stream needs no cancellation; failed reads release asynchronously.
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  signal?.throwIfAborted();
  const output = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output.buffer;
}
