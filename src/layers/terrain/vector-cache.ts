import type { TerrainResult } from './types';

export type TerrainVectors = Pick<TerrainResult, 'labels' | 'lines' | 'borders'>;

/** Keep the visible set resident, then spend the remaining budget on recent tiles.
 * Map insertion order stays stable so cache hits do not reshuffle label placement. */
export class TerrainVectorCache {
  readonly #tiles = new Map<string, { vectors: TerrainVectors; used: number }>();
  #visible = new Set<string>();
  #clock = 0;

  constructor(readonly limit = 128) {}

  get size(): number { return this.#tiles.size; }
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
    this.#tiles.set(key, { vectors, used: ++this.#clock });
    this.#trim();
  }

  visible(): TerrainVectors[] {
    const result: TerrainVectors[] = [];
    for (const [key, tile] of this.#tiles) if (this.#visible.has(key)) result.push(tile.vectors);
    return result;
  }

  clear(): void { this.#tiles.clear(); this.#visible.clear(); this.#clock = 0; }

  #trim(): void {
    // Very large viewports may need more than the normal cache budget. Only
    // current screen coverage may exceed it; it shrinks again as coverage does.
    while (this.#tiles.size > this.limit) {
      let oldest: string | undefined, age = Infinity;
      for (const [key, tile] of this.#tiles) {
        if (!this.#visible.has(key) && tile.used < age) { oldest = key; age = tile.used; }
      }
      if (oldest === undefined) break;
      this.#tiles.delete(oldest);
    }
  }
}
