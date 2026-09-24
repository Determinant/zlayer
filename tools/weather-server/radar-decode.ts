import { gunzipSync } from 'node:zlib';
import { decode as png } from 'fast-png';
import bzip from 'seek-bzip';
import { contours } from 'd3-contour';
import { RADAR_LEVELS, isRadarContours, type RadarContours } from '@zlayer/contracts';

const fail = (): never => { throw new Error('Unsupported or invalid NOAA radar data'); };
const signed = (v: number, bits: number) => v >= 2 ** (bits - 1) ? -(v - 2 ** (bits - 1)) : v;
const epoch = (day: number, seconds: number) => (day - 1) * 86400_000 + seconds * 1000;
const round = (n: number) => Math.round(n * 1e5) / 1e5;
type Field = { width: number; height: number; values: Float32Array; observedAt: number;
  bounds: RadarContours['bounds']; project(x: number, y: number): number[] };
export type ScanWindow = { earliest: number; latest: number };
function checkTime(observedAt: number, window?: ScanWindow) {
  if (!Number.isSafeInteger(observedAt) || observedAt <= 0) fail();
  if (window && observedAt <= window.earliest) throw new Error('Radar scan is too old');
  if (window && observedAt > window.latest) throw new Error('Radar scan is future dated');
}

/** Qualified MRMS GRIB2: regular lat/lon, NOAA local product 209/10/0,
 * PNG packing 5.41, north-to-south scanning. No forecast or color inversion. */
export function decodeMrms(input: Buffer, window?: ScanWindow): Field {
  const b = gunzipSync(input, { maxOutputLength: 8 * 1024 * 1024 });
  if (b.length < 200 || b.toString('ascii', 0, 4) !== 'GRIB' || b[6] !== 209 || b[7] !== 2 ||
    b.readBigUInt64BE(8) !== BigInt(b.length) || b.toString('ascii', b.length - 4) !== '7777') fail();
  const sections = new Map<number, Buffer>(); let offset = 16, previous = 0;
  while (offset < b.length - 4) {
    const size = b.readUInt32BE(offset), id = b[offset + 4]!;
    if (size < 5 || offset + size > b.length - 4 || id <= previous || id > 7) fail();
    sections.set(id, b.subarray(offset, offset + size)); offset += size; previous = id;
  }
  const section = (id: number, size: number) => { const s = sections.get(id); if (!s || s.length !== size) return fail(); return s; };
  const ids = section(1, 21), g = section(3, 72), product = section(4, 34), pack = section(5, 21), bitmap = section(6, 6), data = sections.get(7);
  const observedAt = Date.UTC(ids.readUInt16BE(12), ids[14]! - 1, ids[15], ids[16], ids[17], ids[18]);
  checkTime(observedAt, window);
  if (ids.readUInt16BE(5) !== 161 || ids[10] !== 1 || g.readUInt16BE(12) !== 0 || g[5] !== 0 || g[10] !== 0 || g[71] !== 0 ||
    g.readUInt32BE(38) !== 1 || g.readUInt32BE(42) !== 1_000_000 || product.readUInt16BE(7) !== 0 || product[9] !== 10 || product[10] !== 0 ||
    product.readUInt32BE(18) !== 0 || product[22] !== 102 || pack.readUInt16BE(9) !== 41 || pack[19] !== 16 || bitmap[5] !== 255 || !data) fail();
  const width = g.readUInt32BE(30), height = g.readUInt32BE(34), count = width * height;
  if (width < 2 || height < 2 || count > 25_000_000 || g.readUInt32BE(6) !== count || pack.readUInt32BE(5) !== count) fail();
  const image = data!.subarray(5);
  // Check dimensions before a PNG decoder can allocate based on untrusted IHDR.
  if (image.length < 33 || image.readUInt32BE(16) !== width || image.readUInt32BE(20) !== height || image[24] !== 16 || image[25] !== 0) fail();
  const raster = png(image, { checkCrc: true });
  if (raster.width !== width || raster.height !== height || raster.channels !== 1 || raster.depth !== 16 || raster.data.length !== count) fail();
  const ref = pack.readFloatBE(11), binary = 2 ** signed(pack.readUInt16BE(15), 16), decimal = 10 ** -signed(pack.readUInt16BE(17), 16);
  if (![ref, binary, decimal].every(Number.isFinite) || !binary || !decimal) fail();
  const values = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const value = (ref + raster.data[i]! * binary) * decimal;
    if (value > 100 || value < -999 || !Number.isFinite(value)) fail();
    values[i] = value < -100 ? -100 : value;
  }
  const n = signed(g.readUInt32BE(46), 32) / 1e6, w = g.readUInt32BE(50) / 1e6 - 360;
  const dx = g.readUInt32BE(63) / 1e6, dy = g.readUInt32BE(67) / 1e6;
  if (Math.abs(dx - .01) > 1e-6 || Math.abs(dy - .01) > 1e-6 || Math.abs(w + 129.995) > .001 || Math.abs(n - 54.995) > .001 || width !== 7000 || height !== 3500) fail();
  return { width, height, values, observedAt, bounds: [-130, 20, -60, 55],
    project: (x, y) => [round(w + (x - .5) * dx), round(n - (y - .5) * dy)] };
}

/** NOAA SPG product 180 / packet 16. Threshold table and radial gate spacing
 * belong to each message. Codes 0 and 1 are missing/range-folded, never rain. */
export function decodeTdwr(raw: Buffer, site: string, window?: ScanWindow): Field {
  const header = new RegExp(`^SDUS\\d{2} [A-Z]{4} \\d{6}\\r\\r\\nTZ0${site.slice(1)}\\r\\r\\n`).exec(raw.toString('ascii', 0, 40));
  if (!header) return fail();
  const b = raw.subarray(header[0].length);
  if (b.length < 150 || b.readUInt16BE(0) !== 180 || b.readUInt32BE(8) !== b.length || b.readInt16BE(18) !== -1 || b.readUInt16BE(30) !== 180) fail();
  const d = b.subarray(18, 120), lat = d.readInt32BE(2) / 1000, lon = d.readInt32BE(6) / 1000;
  if (lat < 15 || lat > 60 || lon < -140 || lon > -60 || d.readUInt32BE(90) !== 60 || d.readUInt32BE(94) || d.readUInt32BE(98)) fail();
  const observedAt = epoch(d.readUInt16BE(22), d.readUInt32BE(24));
  checkTime(observedAt, window);
  const length = d.readUInt32BE(84), compression = d.readUInt16BE(82);
  if (length < 28 || length > 1_000_000 || ![0, 1].includes(compression)) fail();
  let block = b.subarray(120);
  if (compression) {
    block = Buffer.alloc(length); let at = 0;
    bzip.decode(b.subarray(120), { writeByte(value) { if (at >= length) fail(); block[at++] = value; } });
    if (at !== length) fail();
  }
  if (block.length !== length || block.readInt16BE(0) !== -1 || block.readUInt16BE(2) !== 1 || block.readUInt32BE(4) !== length ||
    block.readUInt16BE(8) !== 1 || block.readInt16BE(10) !== -1 || block.readUInt32BE(12) !== length - 16 || block.readUInt16BE(16) !== 16) fail();
  const first = block.readUInt16BE(18), width = block.readUInt16BE(20), radials = block.readUInt16BE(28);
  // SPG 180 short-range gates are 150 m; packet 16's scale is not gate length.
  if (first !== 0 || ![592, 600].includes(width) || radials < 1 || radials > 400 || block.readUInt16BE(26) !== 1 || block.readInt16BE(22) || block.readInt16BE(24)) fail();
  const minimum = d.readInt16BE(42) / 10, increment = d.readUInt16BE(44) / 10, levels = d.readUInt16BE(46);
  if (minimum !== -32 || increment !== .5 || levels !== 254) fail();
  const rows: { start: number; end: number; values: Float32Array }[] = []; let offset = 30;
  for (let row = 0; row < radials; row++) {
    if (offset + 6 + width > block.length || block.readUInt16BE(offset) !== width) fail();
    const angle = block.readUInt16BE(offset + 2) / 10, delta = block.readUInt16BE(offset + 4) / 10;
    if (angle >= 360 || delta <= 0 || delta > 2) fail();
    const previous = rows.at(-1)?.start;
    const start = previous === undefined ? angle : previous + (angle - previous % 360 + 360) % 360;
    if (previous !== undefined && start <= previous || start >= (rows[0]?.start ?? start) + 360) fail();
    const values = new Float32Array(width);
    for (let col = 0; col < width; col++) { const code = block[offset + 6 + col]!; values[col] = code < 2 ? -100 : minimum + (code - 2) * increment; }
    rows.push({ start, end: start + delta, values }); offset += 6 + width;
  }
  if (offset !== block.length) fail();
  // Missing azimuths remain missing, including a partial sweep's north seam.
  const expanded: { center: number; values: Float32Array }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!, next = rows[i + 1]?.start ?? rows[0]!.start + 360;
    expanded.push({ center: (row.start + row.end) / 2, values: row.values });
    if (next - row.end > .11) expanded.push({ center: (next + row.end) / 2, values: new Float32Array(width).fill(-100) });
  }
  const height = expanded.length + 2, values = new Float32Array(width * height);
  expanded.forEach((row, i) => values.set(row.values, (i + 1) * width));
  values.set(expanded.at(-1)!.values, 0); values.set(expanded[0]!.values, (height - 1) * width);
  const bearings = [expanded.at(-1)!.center - 360, ...expanded.map(row => row.center), expanded[0]!.center + 360];
  const rad = Math.PI / 180, phi = lat * rad;
  const project = (x: number, y: number) => {
    const distance = Math.max(0, Math.min(width, x)) * .15 / 6371.0088;
    const row = Math.max(0, Math.min(height - 1, y - .5)), lower = Math.floor(row), fraction = row - lower;
    const bearing = (bearings[lower]! + ((bearings[lower + 1] ?? bearings[lower]!) - bearings[lower]!) * fraction) * rad;
    const p = Math.asin(Math.sin(phi) * Math.cos(distance) + Math.cos(phi) * Math.sin(distance) * Math.cos(bearing));
    const l = lon * rad + Math.atan2(Math.sin(bearing) * Math.sin(distance) * Math.cos(phi), Math.cos(distance) - Math.sin(phi) * Math.sin(p));
    return [round(l / rad), round(p / rad)];
  };
  return { width, height, values, observedAt, bounds: [lon - 1.8, lat - .82, lon + 1.8, lat + .82], project };
}

export function prepareRadar(raw: Buffer, site: string, source: string, sourceHash: string, window?: ScanWindow): RadarContours {
  const field = site === 'CONUS' ? decodeMrms(raw, window) : decodeTdwr(raw, site, window);
  if (site === 'CONUS') {
    const stamp = /_(\d{8})-(\d{6})\.grib2\.gz$/.exec(source);
    const expected = stamp && Date.parse(`${stamp[1]!.slice(0, 4)}-${stamp[1]!.slice(4, 6)}-${stamp[1]!.slice(6)}T${stamp[2]!.slice(0, 2)}:${stamp[2]!.slice(2, 4)}:${stamp[2]!.slice(4)}Z`);
    if (field.observedAt !== expected) throw new Error('MRMS filename and observation time disagree');
  }
  const features = contours().size([field.width, field.height]).thresholds([...RADAR_LEVELS])(field.values as unknown as number[]).map(c => ({
    type: 'Feature' as const, properties: { dbz: c.value }, geometry: { type: 'MultiPolygon' as const,
      coordinates: c.coordinates.map(polygon => polygon.map(ring => ring.map(([x, y]) => field.project(x!, y!)))) },
  }));
  const value: RadarContours = { schemaVersion: 1, type: 'FeatureCollection', site, source, sourceHash, observedAt: field.observedAt, bounds: field.bounds, features };
  if (!isRadarContours(value)) throw new Error('Invalid prepared radar contours');
  return value;
}
