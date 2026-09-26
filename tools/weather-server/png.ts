import { inflateSync } from 'node:zlib';
import { decode } from 'fast-png';
import { WeatherSourceError } from './source-error';

type PngLayout = { width: number; height: number } & ({ depth: 16; channels: 1 } | { depth: 8; channels: 4 });
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ANCILLARY = new Set(['bKGD', 'cHRM', 'gAMA', 'pHYs', 'sBIT', 'sRGB', 'tEXt', 'tIME']);

/** Qualified, non-interlaced MRMS grayscale16 and NDFD RGBA8 only. Bound every
 * inflation path before fast-png sees the file, including ancillary chunks. */
export function decodeWeatherPng(bytes: Uint8Array, layout: PngLayout) {
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { width, height, depth, channels } = layout;
  const scanlineBytes = height * (width * channels * depth / 8 + 1);
  const invalid = (message: string): never => { throw new WeatherSourceError(message); };
  if (!Number.isSafeInteger(scanlineBytes) || scanlineBytes <= 0 || scanlineBytes > 64 * 1024 * 1024 ||
    input.length < 45 || !input.subarray(0, 8).equals(SIGNATURE)) invalid('Invalid weather PNG size or signature');
  if (input.readUInt32BE(8) !== 13 || input.toString('ascii', 12, 16) !== 'IHDR' ||
    input.readUInt32BE(16) !== width || input.readUInt32BE(20) !== height || input[24] !== depth ||
    input[25] !== (channels === 1 ? 0 : 6) || input[26] || input[27] || input[28]) invalid('Unsupported weather PNG geometry or encoding');
  const chunks: Buffer[] = [];
  let ended = false, dataEnded = false;
  for (let offset = 33; offset < input.length;) {
    if (offset + 12 > input.length) invalid('Truncated weather PNG chunk');
    const length = input.readUInt32BE(offset), end = offset + length + 12;
    if (end > input.length) invalid('Truncated weather PNG data');
    const kind = input.toString('ascii', offset + 4, offset + 8);
    if (kind === 'IDAT') {
      if (dataEnded) invalid('Nonconsecutive weather PNG image data');
      chunks.push(input.subarray(offset + 8, end - 4));
    } else {
      if (chunks.length) dataEnded = true;
      if (kind === 'IEND') {
        if (length || end !== input.length) invalid('Invalid weather PNG trailer');
        ended = true;
      } else if (!ANCILLARY.has(kind)) invalid(`Unsupported weather PNG chunk ${kind}`);
    }
    offset = end;
  }
  if (!ended || !chunks.length) invalid('Incomplete weather PNG');
  try {
    // fast-png internally accumulates IDAT inflation without an output bound.
    // Preflight the exact scanline size; unsupported compressed metadata above
    // cannot introduce a second, unbounded inflate operation.
    if (inflateSync(Buffer.concat(chunks), { maxOutputLength: scanlineBytes }).length !== scanlineBytes) invalid('Incomplete weather PNG pixel data');
    const image = decode(input, { checkCrc: true });
    if (image.width !== width || image.height !== height || image.depth !== depth || image.channels !== channels ||
      image.data.length !== width * height * channels) invalid('Incomplete weather PNG image');
    return image;
  } catch (cause) {
    throw new WeatherSourceError(cause instanceof Error ? cause.message : String(cause));
  }
}
