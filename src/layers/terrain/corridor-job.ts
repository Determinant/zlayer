import type { Segment } from './geometry';
import type { TerrainCorridor } from './corridor';

/** Coalesces corridor unions independently of tile/source generations. */
export class TerrainCorridorJob {
  #job: { key: string } | undefined;
  #cache: { key: string; data: TerrainCorridor } | undefined;
  failed = false;

  constructor(readonly load: (segments: Segment[]) => Promise<TerrainCorridor>, readonly changed: () => void) {}

  data(key: string) { return this.#cache?.key === key ? this.#cache.data : undefined; }
  resetFailure() { this.failed = false; }
  cancel() { this.#job = undefined; }
  clear() { this.cancel(); this.#cache = undefined; this.failed = false; }

  request(key: string, segments: Segment[], current: () => boolean, publish: (data: TerrainCorridor) => void) {
    if (this.#job || this.failed || this.data(key)) return;
    const job = this.#job = { key };
    const valid = () => this.#job === job && current();
    void (async () => {
      try {
        // Coalesce same-turn edits before dispatch. Completion admits only the
        // latest requested geometry through the owner's changed callback.
        await Promise.resolve();
        if (!valid()) return;
        const data = await this.load(segments);
        if (!valid()) return;
        this.#cache = { key, data };
        publish(data);
      } catch {
        if (valid()) this.failed = true;
      } finally {
        if (this.#job === job) {
          this.#job = undefined;
          this.changed();
        }
      }
    })();
  }
}
