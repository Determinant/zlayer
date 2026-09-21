import { crc32, deflateSync } from 'node:zlib';

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
  size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([size, body, checksum]);
}

// Continuous synthetic ridges crossing tile boundaries, encoded in actual Terrarium meters.
export function terrainMeters(wx, wy) {
  return 1000 + 650 * Math.sin(wx * 1900) * Math.cos(wy * 1300);
}

export function terrainPng(z, tileX, tileY, sample = terrainMeters) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(256); header.writeUInt32BE(256, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(256 * 1025);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const wx = (tileX + (x + 0.5) / 256) / 2 ** z;
    const wy = (tileY + (y + 0.5) / 256) / 2 ** z;
    const meters = sample(wx, wy);
    const encoded = Math.round((meters + 32768) * 256), offset = y * 1025 + 1 + x * 4;
    pixels[offset] = encoded >>> 16; pixels[offset + 1] = (encoded >>> 8) & 255;
    pixels[offset + 2] = encoded & 255; pixels[offset + 3] = 255;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
