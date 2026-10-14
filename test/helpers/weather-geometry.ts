export type Point = [number, number];

export function randomSequence(seed: number): () => number {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
}

// Translate before taking cross products so tiny shapes at large longitudes do
// not disappear through cancellation in the test oracle itself.
export function signedArea(ring: readonly Point[]): number {
  const [x, y] = ring[0]!;
  return ring.slice(1).reduce((sum, b, i) => {
    const a = ring[i]!;
    return sum + (a[0] - x) * (b[1] - y) - (b[0] - x) * (a[1] - y);
  }, 0) / 2;
}

export function ringLength(ring: readonly Point[]): number {
  return ring.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - ring[i]![0], p[1] - ring[i]![1]), 0);
}

export function containsPoint(ring: readonly Point[], [x, y]: Point): boolean {
  let inside = false;
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1]!, b = ring[i]!;
    if ((a[1] > y) !== (b[1] > y) && x < a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1])) inside = !inside;
  }
  return inside;
}

export function boundaryDistance(p: Point, ring: readonly Point[]): number {
  return Math.min(...ring.slice(1).map((b, i) => {
    const a = ring[i]!, dx = b[0] - a[0], dy = b[1] - a[1];
    const t = dx || dy ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy))) : 0;
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  }));
}
