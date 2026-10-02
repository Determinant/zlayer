/** Reuse whole-cell maxima from immutable decoded 256px elevation tiles.
 * Weak source keys do not retain the decoder's large tiles. The separate LRU
 * bounds pooled arrays and removes evicted variants from their weak entry. */
export class ElevationTilePool {
  #sources = new WeakMap<Float32Array, Map<number, Float32Array>>();
  #resident = new Map<Float32Array, { variants: Map<number, Float32Array>; factor: number }>();
  #bytes = 0;
  sourceCells = 0;
  constructor(readonly budget = 4 * 1024 * 1024) {}
  get byteLength() { return this.#bytes; }
  clear() { this.#sources = new WeakMap(); this.#resident.clear(); this.#bytes = 0; }
  maximum(source: Float32Array, factor: number): Float32Array {
    if (source.length !== 65536 || factor < 1 || factor > 256 || !Number.isInteger(Math.log2(factor))) throw new Error('Invalid elevation pooling factor');
    if (factor === 1) return source;
    let variants = this.#sources.get(source);
    const previous = variants?.get(factor);
    if (previous) {
      const entry = this.#resident.get(previous)!;
      this.#resident.delete(previous); this.#resident.set(previous, entry); return previous;
    }
    const width = 256 / factor, values = new Float32Array(width * width).fill(-Infinity);
    // Math.max propagates NaN; every source cell participates, including peaks.
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      const index = Math.floor(y / factor) * width + Math.floor(x / factor), value = source[y * 256 + x]!;
      values[index] = Number.isFinite(value) ? Math.max(values[index]!, value) : NaN;
    }
    this.sourceCells += source.length;
    if (!variants) { variants = new Map(); this.#sources.set(source, variants); }
    variants.set(factor, values); this.#resident.set(values, { variants, factor }); this.#bytes += values.byteLength;
    while (this.#bytes > this.budget) {
      const [first, entry] = this.#resident.entries().next().value!;
      entry.variants.delete(entry.factor); this.#resident.delete(first); this.#bytes -= first.byteLength;
    }
    return values;
  }
}
