/** Outlined direction chevron, generated locally so it is available offline. */
export function holdArrowImage(color: readonly [number, number, number], outline: readonly [number, number, number], strokeScale: number) {
  const size = 48, data = new Uint8Array(size * size * 4);
  const segments = [[[10, 33], [24, 15]], [[24, 15], [38, 33]]] as const;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const distance = Math.min(...segments.map(([a, b]) => {
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((x + .5 - a[0]) * dx + (y + .5 - a[1]) * dy) / (dx * dx + dy * dy)));
      return Math.hypot(x + .5 - a[0] - t * dx, y + .5 - a[1] - t * dy);
    }));
    const fill = Math.max(0, Math.min(1, 4 * strokeScale + .5 - distance));
    const alpha = Math.max(0, Math.min(1, 7 * strokeScale + .5 - distance));
    data.set([
      ...color.map((channel, i) => Math.round(outline[i]! + (channel - outline[i]!) * fill)),
      Math.round(255 * alpha),
    ], (y * size + x) * 4);
  }
  return { width: size, height: size, data };
}
