import type { TerrainResult } from './types';

export type TerrainVectors = Pick<TerrainResult, 'labels' | 'lines' | 'borders'>;

// Approximate retained JS storage, including coordinate arrays and their slots.
// This is an eviction weight, not a browser heap measurement or serialized size.
function vectorBytes(vectors: TerrainVectors): number {
  let bytes = 128 + vectors.labels.length * 160;
  for (const line of vectors.lines) {
    bytes += 128;
    for (const path of line.coordinates) bytes += 48 + path.length * 80;
  }
  for (const border of vectors.borders ?? []) bytes += 256 + border.top.byteLength + border.right.byteLength + border.bottom.byteLength + border.left.byteLength;
  return bytes;
}

/** Keep the visible set resident, then spend the remaining budget on recent tiles.
 * Map insertion order stays stable so cache hits do not reshuffle label placement. */
export class TerrainVectorCache {
  readonly #tiles = new Map<string, { vectors: TerrainVectors; used: number; bytes: number }>();
  #visible = new Set<string>();
  #clock = 0;
  #bytes = 0;

  constructor(readonly limit = 128, readonly byteLimit = 32 * 1024 * 1024) {}

  get size(): number { return this.#tiles.size; }
  get estimatedBytes(): number { return this.#bytes; }
  has(key: string): boolean { return this.#tiles.has(key); }

  setVisible(keys: Iterable<string>): void {
    this.#visible = new Set(keys);
    for (const key of this.#visible) {
      const tile = this.#tiles.get(key);
      if (tile) tile.used = ++this.#clock;
    }
    this.#trim();
  }

  put(key: string, vectors: TerrainVectors): void {
    this.#bytes -= this.#tiles.get(key)?.bytes ?? 0;
    const bytes = vectorBytes(vectors);
    this.#tiles.set(key, { vectors, used: ++this.#clock, bytes });
    this.#bytes += bytes;
    this.#trim();
  }

  visible(): TerrainVectors[] {
    const result: TerrainVectors[] = [];
    for (const [key, tile] of this.#tiles) if (this.#visible.has(key)) result.push(tile.vectors);
    return result;
  }

  clear(): void { this.#tiles.clear(); this.#visible.clear(); this.#clock = 0; this.#bytes = 0; }

  #trim(): void {
    // Very large viewports may need more than the normal cache budget. Only
    // current screen coverage may exceed it; it shrinks again as coverage does.
    while (this.#tiles.size > this.limit || this.#bytes > this.byteLimit) {
      let oldest: string | undefined, age = Infinity;
      for (const [key, tile] of this.#tiles) {
        if (!this.#visible.has(key) && tile.used < age) { oldest = key; age = tile.used; }
      }
      if (oldest === undefined) break;
      this.#bytes -= this.#tiles.get(oldest)!.bytes;
      this.#tiles.delete(oldest);
    }
  }
}
