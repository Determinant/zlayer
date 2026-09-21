import type { Map as MapLibreMap } from 'maplibre-gl';

// A stable insertion point keeps refreshed charts below navigation/weather/routes.
export const CHART_LAYER_ANCHOR = 'zlayer-chart-slot';
export const PLATE_LAYER_ANCHOR = 'zlayer-plate-slot';
export const TERRAIN_LAYER_ANCHOR = 'zlayer-terrain-slot';
// Route lines sit above charts, but below navigation symbols and waypoint labels.
export const ROUTE_LINE_ANCHOR = 'zlayer-route-line-slot';

export type LayerSlot = 'charts' | 'plates' | 'terrain' | 'navigation' | 'weather' | 'route' | 'ownship';

/** A product's map contribution owns resources and work for one attachment. */
export interface MapLayerModule<Input> {
  readonly id: string;
  readonly slot: LayerSlot;
  readonly interactiveLayerIds?: readonly string[];
  readonly foregroundLayerIds?: readonly string[];
  mount(map: MapLibreMap): void;
  update(input: Input): void;
  unmount(): void;
}

type MountableLayer = Omit<MapLayerModule<never>, 'update'>;
const slots: readonly LayerSlot[] = ['charts', 'plates', 'terrain', 'navigation', 'weather', 'route', 'ownship'];

/** Host-owned insertion point for a module that recreates foreground layers. */
export function foregroundLayerAnchor(moduleId: string): string { return `zlayer-foreground-${moduleId}`; }

export class MapLayerHost {
  readonly #mounted: MountableLayer[] = [];
  readonly #failed = new Set<string>();
  readonly #foregroundAnchors: string[] = [];

  constructor(readonly map: MapLibreMap, readonly onError: (id: string, error: unknown) => void) {}

  mount(layers: readonly MountableLayer[]): void {
    this.unmount();
    this.#failed.clear();
    const ids = new Set<string>();
    for (const layer of layers) {
      if (ids.has(layer.id)) throw new Error(`Duplicate layer module: ${layer.id}`);
      ids.add(layer.id);
    }
    for (const layer of [...layers].sort((a, b) => slots.indexOf(a.slot) - slots.indexOf(b.slot))) {
      try {
        layer.mount(this.map);
        this.#mounted.push(layer);
      } catch (error) {
        this.#fail(layer, error);
      }
    }
    // Context and route labels must stay above circles from every product.
    for (const layer of this.#mounted) {
      try {
        if (!layer.foregroundLayerIds?.length || this.#failed.has(layer.id)) continue;
        const anchor = foregroundLayerAnchor(layer.id);
        this.map.addLayer({ id: anchor, type: 'background', paint: { 'background-opacity': 0 } });
        this.#foregroundAnchors.push(anchor);
        for (const id of layer.foregroundLayerIds ?? []) {
          if (this.map.getLayer(id)) this.map.moveLayer(id, anchor);
        }
      } catch (error) {
        this.#fail(layer, error);
      }
    }
  }

  update<Input>(layer: MapLayerModule<Input>, input: Input): void {
    if (this.#failed.has(layer.id)) return;
    try { layer.update(input); }
    catch (error) { this.#fail(layer, error); }
  }

  interactiveLayerIds(): string[] {
    return this.#mounted.flatMap(layer => this.#failed.has(layer.id) ? [] :
      (layer.interactiveLayerIds ?? []).filter(id => this.map.getLayer(id)));
  }

  unmount(): void {
    for (const layer of this.#mounted.splice(0).reverse()) {
      try { layer.unmount(); }
      catch (error) { this.onError(layer.id, error); }
    }
    for (const id of this.#foregroundAnchors.splice(0)) if (this.map.getLayer(id)) this.map.removeLayer(id);
  }

  #fail(layer: MountableLayer, error: unknown): void {
    this.#failed.add(layer.id);
    try { layer.unmount(); }
    catch (cleanupError) { this.onError(layer.id, cleanupError); }
    this.onError(layer.id, error);
  }
}

export function removeLayerResources(
  map: MapLibreMap, layers: readonly string[], sources: readonly string[],
): void {
  for (const id of [...layers].reverse()) if (map.getLayer(id)) map.removeLayer(id);
  for (const id of sources) if (map.getSource(id)) map.removeSource(id);
}
