import type { Tile } from 'maplibre-gl';
import { externalErrorCode, resourceErrorCode } from '../../core/data/errors';

export function mapErrorMessage(event: { error: { name?: string; message: string }; sourceId?: string }): string | undefined {
  if (event.error.name === 'AbortError') return undefined;
  if (event.sourceId === 'zlayer-basemap') return 'Background imagery is unavailable. You can still use saved charts and navigation.';
  return `${event.sourceId ?? 'Map'}: ${event.error.message}`;
}

/** Classify the original error before replacing provider details with UI copy. */
export function mapErrorCode(error: { message: string }) {
  return resourceErrorCode(error) ?? externalErrorCode(error.message);
}

type RequestTile = Pick<Tile, 'state' | 'uses'>;
type TileEvent = { sourceId?: string; tile?: RequestTile };
type SourceErrors = { tiles: Set<WeakRef<RequestTile>>; recovered: boolean };

/** One request condition per source, without retaining tile data or URL history.
 * A settled source can still contain failed tiles; idle alone is not recovery. */
export class MapTileErrors {
  readonly #sources = new Map<string, SourceErrors>();

  failed(event: TileEvent & { error: { message: string } }): string | undefined {
    const code = mapErrorCode(event.error);
    if (!event.sourceId || code !== 'request' && code !== 'http') return;
    let source = this.#sources.get(event.sourceId);
    if (!source) this.#sources.set(event.sourceId, source = { tiles: new Set(), recovered: false });
    this.#forget(source, event.tile);
    if (event.tile && event.tile.uses > 0) source.tiles.add(new WeakRef(event.tile));
    source.recovered = false;
    return event.sourceId;
  }

  loaded(event: TileEvent): string | undefined {
    if (event.tile?.state !== 'loaded' || !event.sourceId) return;
    const source = this.#sources.get(event.sourceId);
    if (source) source.recovered = true;
    return this.removed(event);
  }

  removed(event: TileEvent): string | undefined {
    if (!event.sourceId || !event.tile) return;
    const source = this.#sources.get(event.sourceId);
    if (!source) return;
    this.#forget(source, event.tile);
    // Panning during an ongoing outage discards failed tiles too. Require a
    // successful tile before declaring that the remaining view recovered.
    if (source.tiles.size || !source.recovered) return;
    return this.removeSource(event.sourceId);
  }

  #forget(source: SourceErrors, removed?: RequestTile): void {
    // MapLibre mutates tile IDs on wrap jumps and can cache/evict failed refreshes
    // without abort events. Object identity survives wrapping; uses === 0 means
    // the tile left current demand. Weak references never keep its data alive.
    for (const reference of source.tiles) {
      const tile = reference.deref();
      if (!tile || tile === removed || tile.uses === 0 || tile.state === 'loaded') source.tiles.delete(reference);
    }
  }

  removeSource(sourceId: string): string | undefined {
    return this.#sources.delete(sourceId) ? sourceId : undefined;
  }

  clear(): readonly string[] {
    const sources = [...this.#sources.keys()];
    this.#sources.clear();
    return sources;
  }
}
