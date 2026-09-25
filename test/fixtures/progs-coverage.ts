import { encode } from 'fast-png';

/** Synthetic geographic stripes for deterministic map colors, not NOAA data. */
export function coveragePng(variant = 0): Uint8Array<ArrayBuffer> {
  const width = 900, height = 600, data = new Uint8Array(width * height * 4);
  const colors = [[0, 150, 65], [5, 112, 176], [240, 228, 66]];
  for (let y = 150; y < 450; y++) for (let x = 50; x < 750; x++) {
    const color = colors[(Math.floor(x / 180) + variant) % colors.length]!;
    data.set([...color, 255], (y * width + x) * 4);
  }
  return Uint8Array.from(encode({ width, height, data, channels: 4, depth: 8 }));
}
