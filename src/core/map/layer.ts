import type { Map as MapLibreMap } from 'maplibre-gl';
import { LayerScope } from '../layers/scope';

// A stable insertion point keeps refreshed charts below navigation/weather/routes.
export const CHART_LAYER_ANCHOR = 'zlayer-chart-slot';
export const PLATE_LAYER_ANCHOR = 'zlayer-plate-slot';
export const TERRAIN_LAYER_ANCHOR = 'zlayer-terrain-slot';
// Advisory/grid shading stays above terrain and below every route/navigation layer.
export const WEATHER_LAYER_ANCHOR = 'zlayer-weather-slot';
// Route lines sit above charts, but below navigation symbols and waypoint labels.
export const ROUTE_LINE_ANCHOR = 'zlayer-route-line-slot';

export type LayerSlot = 'charts' | 'plates' | 'terrain' | 'navigation' | 'weather' | 'route' | 'annotation' | 'ownship';

/** A product's map contribution owns resources and work for one attachment. */
export interface MapLayerModule<Input> {
  readonly id: string;
  readonly slot: LayerSlot;
  readonly interactiveLayerIds?: readonly string[];
  readonly foregroundLayerIds?: readonly string[];
  /** Unanchored style layers in drawing order, below all foreground layers. */
  readonly overlayLayerIds?: readonly string[];
  mount(map: MapLibreMap): void;
  update(input: Input): void;
  /** Bound contributions observe their own inputs; legacy adapters can still use update(). */
  subscribeInputs?: (listener: () => void) => () => void;
  unmount(): void;
}

type MountableLayer = Omit<MapLayerModule<never>, 'update'>;
const slots: readonly LayerSlot[] = ['charts', 'plates', 'terrain', 'navigation', 'weather', 'route', 'annotation', 'ownship'];

/** Host-owned insertion point for a module that recreates foreground layers. */
export function foregroundLayerAnchor(moduleId: string): string { return `zlayer-foreground-${moduleId}`; }

export class MapLayerHost {
  readonly #mounted: MountableLayer[] = [];
  #requested: readonly MountableLayer[] = [];
  readonly #failed = new Set<string>();
  readonly #scopes = new Map<string, LayerScope>();

  constructor(readonly map: MapLibreMap, readonly onError: (id: string, error: unknown) => void, readonly onUpdate: () => void = () => {}) {}

  mount(layers: readonly MountableLayer[]): void {
    this.unmount();
    this.reconcile(layers);
  }

  /** Keep unchanged adapters alive, including their subscriptions and live demand. */
  reconcile(layers: readonly MountableLayer[]): void {
    const ids = new Set<string>();
    for (const layer of layers) {
      if (ids.has(layer.id)) throw new Error(`Duplicate layer module: ${layer.id}`);
      ids.add(layer.id);
    }
    const ordered = [...layers].sort((a, b) => slots.indexOf(a.slot) - slots.indexOf(b.slot));
    if (ordered.length === this.#requested.length && ordered.every((layer, index) => layer === this.#requested[index])) return;
    for (const layer of [...this.#requested].reverse()) {
      if (ordered.includes(layer)) continue;
      if (this.#mounted.includes(layer)) this.#detach(layer);
      this.#failed.delete(layer.id);
    }
    this.#requested = ordered;
    for (const layer of ordered) {
      if (this.#mounted.includes(layer) || this.#failed.has(layer.id)) continue;
      try {
        layer.mount(this.map);
        this.#mounted.push(layer);
        if (layer.subscribeInputs) {
          const scope = new LayerScope(error => this.onError(layer.id, error));
          this.#scopes.set(layer.id, scope);
          scope.add(layer.subscribeInputs(() => { this.onUpdate(); this.update(layer as MapLayerModule<void>, undefined); }));
        }
      } catch (error) {
        this.#fail(layer, error);
      }
    }
    this.#mounted.sort((a, b) => ordered.indexOf(a) - ordered.indexOf(b));
    // Imports may finish in any order. Reorder style resources, never attachments.
    for (const layer of [...this.#mounted]) {
      try {
        for (const id of layer.overlayLayerIds ?? []) {
          if (!layer.foregroundLayerIds?.includes(id) && this.map.getLayer(id)) this.map.moveLayer(id);
        }
      } catch (error) { this.#fail(layer, error); }
    }
    // Context and route labels must stay above circles from every product.
    for (const layer of [...this.#mounted]) {
      try {
        if (!layer.foregroundLayerIds?.length) continue;
        const anchor = foregroundLayerAnchor(layer.id);
        if (!this.map.getLayer(anchor)) {
          this.map.addLayer({ id: anchor, type: 'background', paint: { 'background-opacity': 0 } });
        } else this.map.moveLayer(anchor);
        for (const id of layer.foregroundLayerIds) {
          if (this.map.getLayer(id)) this.map.moveLayer(id, anchor);
        }
      } catch (error) { this.#fail(layer, error); }
    }
  }

  update<Input>(layer: MapLayerModule<Input>, input: Input): void {
    if (!this.#mounted.includes(layer)) return;
    try { layer.update(input); }
    catch (error) { this.#fail(layer, error); }
  }

  /** Fast event-driven work uses the same failure boundary as store updates. */
  run(id: string, action: () => void): void {
    const owner = this.#mounted.find(layer => layer.id === id);
    if (!owner) return;
    try { action(); } catch (error) { this.#fail(owner, error); }
  }

  interactiveLayerIds(): string[] {
    return this.#mounted.flatMap(layer =>
      (layer.interactiveLayerIds ?? []).filter(id => this.map.getLayer(id)));
  }

  hasFailures(): boolean { return this.#failed.size > 0; }

  unmount(): void {
    for (const layer of [...this.#mounted].reverse()) this.#detach(layer);
    this.#requested = [];
    this.#failed.clear();
  }

  #detach(layer: MountableLayer): void {
    const mounted = this.#mounted.indexOf(layer);
    if (mounted >= 0) this.#mounted.splice(mounted, 1);
    this.#scopes.get(layer.id)?.dispose();
    this.#scopes.delete(layer.id);
    try { layer.unmount(); }
    catch (error) { this.onError(layer.id, error); }
    const anchor = foregroundLayerAnchor(layer.id);
    try { if (layer.foregroundLayerIds?.length && this.map.getLayer(anchor)) this.map.removeLayer(anchor); }
    catch (error) { this.onError(layer.id, error); }
  }

  #fail(layer: MountableLayer, error: unknown): void {
    this.#failed.add(layer.id);
    this.#detach(layer);
    this.onError(layer.id, error);
  }
}

export function removeLayerResources(
  map: MapLibreMap, layers: readonly string[], sources: readonly string[],
): void {
  for (const id of [...layers].reverse()) if (map.getLayer(id)) map.removeLayer(id);
  for (const id of sources) if (map.getSource(id)) map.removeSource(id);
}
