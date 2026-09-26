/** Qualified GRIB2 subset: WMO templates 3.30, 4.0, 5.0/5.2/5.3.
 * NOAA template specifications and independent GDAL comparisons are recorded in README.md.
 * Unsupported packing, metadata or scanning must fail, never guess weather values. */
export type GribIdentity = { runTime: number; lead: number; category: number; parameter: number; surface: number; altitude?: number; pressureHpa?: number };
export type LambertGrid = { width: number; height: number; latitude: number; longitude: number;
  originLatitude: number; meridian: number; parallel1: number; parallel2: number; dx: number; dy: number; signature: string; gridRelative?: boolean };
export type GribField = { grid: LambertGrid; values: Float32Array };
const fail = (message: string): never => { throw new Error(`Unsupported or invalid GRIB: ${message}`); };
const signed = (value: number, bits: number) => value >= 2 ** (bits - 1) ? -(value - 2 ** (bits - 1)) : value;
const longitude = (value: number) => value > 180 ? value - 360 : value;

class Bits {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}
  read(count: number): number {
    if (count < 0 || count > 32 || this.offset + count > this.bytes.length * 8) fail('packed bit count');
    let value = 0;
    while (count) {
      const bit = this.offset & 7, take = Math.min(count, 8 - bit);
      // A read is at most 32 bits and each step at most eight. Keep the same
      // unsigned bit pattern without exponentiation for every decoded byte.
      value = (value << take) | ((this.bytes[this.offset >>> 3]! >>> (8 - bit - take)) & ((1 << take) - 1));
      this.offset += take; count -= take;
    }
    return value >>> 0;
  }
  align() { this.offset = Math.ceil(this.offset / 8) * 8; }
}

const LAMBERT_RESOLUTION_FLAGS = 46;
const GRID_RELATIVE_COMPONENTS = 8;
/** GRIB section 3 is serialized as hex for identity. Vector orientation is a
 * field attribute; ignore just that flag when matching terrain/scalar geometry. */
export function lambertGeometrySignature(signature: string): string {
  const start = LAMBERT_RESOLUTION_FLAGS * 2;
  const flags = parseInt(signature.slice(start, start + 2), 16) & ~GRID_RELATIVE_COMPONENTS;
  return signature.slice(0, start) + flags.toString(16).padStart(2, '0') + signature.slice(start + 2);
}

function readSections(bytes: ArrayBuffer) {
  const view = new DataView(bytes);
  if (bytes.byteLength < 100 || bytes.byteLength > 8 * 1024 * 1024 || view.getUint32(0) !== 0x47524942 ||
    view.getUint8(6) !== 0 || view.getUint8(7) !== 2 || view.getBigUint64(8) !== BigInt(bytes.byteLength) ||
    view.getUint32(bytes.byteLength - 4) !== 0x37373737) fail('message framing');
  const sections = new Map<number, DataView>();
  let offset = 16, previous = 0;
  while (offset < bytes.byteLength - 4) {
    if (offset + 5 > bytes.byteLength - 4) fail('section header');
    const length = view.getUint32(offset), section = view.getUint8(offset + 4);
    if (length < 5 || offset + length > bytes.byteLength - 4 || section <= previous || section > 7) fail('sections');
    sections.set(section, new DataView(bytes, offset, length)); offset += length; previous = section;
  }
  const section = (id: number, min: number) => {
    const data = sections.get(id);
    if (!data || data.byteLength < min) return fail(`section ${id}`);
    return data;
  };
  return section;
}

function checkIdentity(ids: DataView, product: DataView, expected: GribIdentity) {
  const runTime = Date.UTC(ids.getUint16(12), ids.getUint8(14) - 1, ids.getUint8(15), ids.getUint8(16), ids.getUint8(17), ids.getUint8(18));
  if (ids.getUint16(5) !== 7 || runTime !== expected.runTime || product.getUint16(5) !== 0 || product.getUint16(7) !== 0 ||
    product.getUint8(9) !== expected.category || product.getUint8(10) !== expected.parameter || product.getUint8(17) !== 1 ||
    product.getUint32(18) !== expected.lead || product.getUint8(22) !== expected.surface || product.getUint8(28) !== 255) fail('forecast identity');
  if (expected.category === 19 && (ids.getUint16(7) !== 8 || ids.getUint8(9) !== 2 || ids.getUint8(10) !== 1)) fail('IFI local table');
  if (expected.altitude !== undefined && Math.abs(product.getUint32(24) * 10 ** -signed(product.getUint8(23), 8) - expected.altitude * 0.3048) > 0.001) fail('altitude');
  if (expected.pressureHpa !== undefined && (expected.surface !== 100 || Math.abs(product.getUint32(24) * 10 ** -signed(product.getUint8(23), 8) - expected.pressureHpa * 100) > 0.001)) fail('pressure level');
}

function readLambertGrid(g: DataView): LambertGrid {
  const width = g.getUint32(30), height = g.getUint32(34), points = width * height;
  if (g.getUint8(5) !== 0 || g.getUint8(10) !== 0 || g.getUint16(12) !== 30 || g.getUint8(14) !== 6 ||
    g.getUint8(63) !== 0 || g.getUint8(64) !== 64 || g.getUint32(73) !== 0 || g.getUint32(77) !== 0 ||
    width < 2 || height < 2 || points > 4_000_000 || g.getUint32(6) !== points) fail('Lambert geometry or scanning');
  const angle = (at: number) => signed(g.getUint32(at), 32) / 1e6;
  const grid: LambertGrid = { width, height, latitude: angle(38), longitude: longitude(angle(42)),
    originLatitude: angle(47), meridian: longitude(angle(51)), parallel1: angle(65), parallel2: angle(69),
    dx: g.getUint32(55) / 1000, dy: g.getUint32(59) / 1000, gridRelative: !!(g.getUint8(LAMBERT_RESOLUTION_FLAGS) & GRID_RELATIVE_COMPONENTS),
    signature: [...new Uint8Array(g.buffer, g.byteOffset, g.byteLength)].map(n => n.toString(16).padStart(2, '0')).join('') };
  if (![grid.latitude, grid.originLatitude, grid.parallel1, grid.parallel2].every(n => n > 0 && n < 90) ||
    ![grid.dx, grid.dy].every(n => n >= 500 && n <= 20000)) fail('projection bounds');
  return grid;
}

function unpackComplex(bits: Bits, packing: DataView, count: number, refBits: number, template: number, emit: (value: number) => void) {
  if (packing.byteLength !== (template === 3 ? 49 : 47) || packing.getUint8(21) !== 1 || packing.getUint8(22) !== 0) fail('complex packing options');
  const groups = packing.getUint32(31), order = template === 3 ? packing.getUint8(47) : 0, octets = template === 3 ? packing.getUint8(48) : 0;
  if (groups > count || ![0, 1, 2].includes(order) || octets > 4) fail('complex descriptors');
  if (!groups) { for (let i = 0; i < count; i++) emit(0); }
  else {
    if (order && !octets) fail('spatial descriptors');
    const initial = Array.from({ length: order }, () => bits.read(octets * 8));
    const minimum = order ? signed(bits.read(octets * 8), octets * 8) : 0;
    const widthReference = packing.getUint8(35), widthBits = packing.getUint8(36);
    const lengthReference = packing.getUint32(37), lengthIncrement = packing.getUint8(41);
    const lastLength = packing.getUint32(42), lengthBits = packing.getUint8(46);
    const refs = new Uint32Array(groups), widths = new Uint8Array(groups), lengths = new Uint32Array(groups);
    for (let i = 0; i < groups; i++) refs[i] = bits.read(refBits);
    bits.align();
    for (let i = 0; i < groups; i++) {
      const width = widthReference + bits.read(widthBits);
      if (width > 32) fail('group width');
      widths[i] = width;
    }
    bits.align();
    let total = 0;
    for (let i = 0; i < groups; i++) {
      const length = lengthReference + bits.read(lengthBits) * lengthIncrement;
      lengths[i] = i === groups - 1 ? lastLength : length; total += lengths[i]!;
    }
    if (total !== count) fail('group lengths');
    bits.align();
    let first = initial[0] ?? 0, second = initial[1] ?? 0, at = 0;
    for (let group = 0; group < groups; group++) for (let j = 0; j < lengths[group]!; j++) {
      let integer = refs[group]! + bits.read(widths[group]!);
      if (at < order) integer = initial[at]!;
      else if (order === 1) { integer += minimum + first; first = integer; }
      else if (order === 2) { integer += minimum + 2 * second - first; first = second; second = integer; }
      emit(integer); at++;
    }
  }
}

function readSamples(packing: DataView, bitmap: DataView, data: DataView, points: number): Float32Array {
  const count = packing.getUint32(5), template = packing.getUint16(9), bitmapType = bitmap.getUint8(5);
  if (count > points || ![0, 2, 3].includes(template) || ![0, 255].includes(bitmapType) ||
    (bitmapType === 0 ? bitmap.byteLength !== 6 + Math.ceil(points / 8) : count !== points)) fail('packing or bitmap');
  const result = new Float32Array(points); result.fill(NaN);
  const bitmapBytes = new Uint8Array(bitmap.buffer, bitmap.byteOffset + 6, bitmap.byteLength - 6);
  const reference = packing.getFloat32(11), binary = 2 ** signed(packing.getUint16(15), 16), decimal = 10 ** -signed(packing.getUint16(17), 16);
  if (![reference, binary, decimal].every(Number.isFinite) || !binary || !decimal) fail('scale');
  let cell = 0, emitted = 0;
  const emit = (integer: number) => {
    if (bitmapType === 0) while (cell < points && !(bitmapBytes[cell >>> 3]! & (128 >>> (cell & 7)))) cell++;
    if (cell >= points || !Number.isSafeInteger(integer)) fail('sample count or spatial difference');
    result[cell++] = (reference + integer * binary) * decimal; emitted++;
  };
  const bits = new Bits(new Uint8Array(data.buffer, data.byteOffset + 5, data.byteLength - 5));
  const refBits = packing.getUint8(19);
  if (template === 0) {
    for (let i = 0; i < count; i++) emit(bits.read(refBits));
  } else {
    unpackComplex(bits, packing, count, refBits, template, emit);
  }

  if (emitted !== count || bits.bytes.length * 8 - bits.offset > 7) fail('trailing packed data');
  if (bitmapType === 0) {
    let marked = 0;
    for (let i = 0; i < points; i++) if (bitmapBytes[i >>> 3]! & (128 >>> (i & 7))) marked++;
    if (marked !== count) fail('bitmap count');
  }
  return result;
}

export function decodeGrib(bytes: ArrayBuffer, expected: GribIdentity): GribField {
  const section = readSections(bytes);
  checkIdentity(section(1, 21), section(4, 34), expected);
  const grid = readLambertGrid(section(3, 81));
  const values = readSamples(section(5, 21), section(6, 6), section(7, 5), grid.width * grid.height);
  return { grid, values };
}
