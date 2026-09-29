import { Map as MapLibreMap } from 'maplibre-gl';

/** MapLibre 6.9's resize guard waits for the asynchronous context-lost event.
 * Until then, a resize can mistake the lost buffer's zero size for a GPU limit
 * and permanently collapse the canvas. Check WebGL's immediate state instead.
 * MapLibre's restoration handler applies the current container size afterward. */
export class Map extends MapLibreMap {
  override resize(...args: Parameters<MapLibreMap['resize']>): this {
    if (this.getCanvas().getContext('webgl2')?.isContextLost()) return this;
    return super.resize(...args);
  }
}
