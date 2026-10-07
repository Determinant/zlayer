import type { Segment } from './geometry';
import type { TerrainIsoline } from './isolines';
import { prepareTerrainContours } from './seams';
import type { TerrainVectors } from './vector-cache';

type Request = { tiles: TerrainVectors[]; segments: Segment[]; publish: (lines: TerrainIsoline[]) => void };

/** One preparation and one latest snapshot. Superseded work releases its
 * temporary indexes at the next task boundary before another job starts. */
export class TerrainContourJob {
  #active: AbortController | undefined;
  #next: Request | undefined;
  failed = false;

  constructor(readonly changed: () => void, readonly prepare = prepareTerrainContours) {}

  get pending() { return !!this.#active || !!this.#next; }

  request(tiles: TerrainVectors[], segments: Segment[], publish: Request['publish']) {
    this.#next = { tiles, segments, publish };
    this.failed = false;
    this.#active?.abort();
    this.#start();
  }

  clear() {
    this.#next = undefined;
    this.#active?.abort();
    this.failed = false;
  }

  #start() {
    if (this.#active || !this.#next) return;
    const request = this.#next;
    this.#next = undefined;
    const controller = this.#active = new AbortController();
    void (async () => {
      try {
        const lines = await this.prepare(request.tiles.flatMap(tile => tile.lines),
          request.tiles.flatMap(tile => tile.borders ?? []), request.segments, controller.signal);
        if (!controller.signal.aborted) request.publish(lines);
      } catch {
        if (!controller.signal.aborted) this.failed = true;
      } finally {
        this.#active = undefined;
        this.#start();
        if (!controller.signal.aborted || this.pending) this.changed();
      }
    })();
  }
}
