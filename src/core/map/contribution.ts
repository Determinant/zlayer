import type { Map as MapLibreMap } from 'maplibre-gl';
import type { LayerStore } from '../layers/store';
import type { MapLayerModule } from './layer';

export type ScreenRect = { left: number; right: number; top: number; bottom: number };

/** Application policy is supplied as callbacks; rendering entries may use MapLibre. */
export type MapContributionContext = {
  map: MapLibreMap;
  signal: AbortSignal;
  preserveView: boolean;
  interactiveLayerIds(): string[];
  occupiedRects(): ScreenRect[];
  targetBearing(): number;
  run(id: string, action: () => void): void;
  reportError(error: unknown): void;
};

export type MapContribution = {
  id: string;
  load(context: MapContributionContext): Promise<readonly MapLayerModule<void>[]>;
};

/** Bind only this feature's input store; the map host guards subscription updates. */
export function bindMapLayer<T>(layer: MapLayerModule<T>, input: LayerStore<T>): MapLayerModule<void> {
  return {
    id: layer.id,
    slot: layer.slot,
    get interactiveLayerIds() { return layer.interactiveLayerIds ?? []; },
    get overlayLayerIds() { return layer.overlayLayerIds ?? []; },
    get foregroundLayerIds() { return layer.foregroundLayerIds ?? []; },
    mount(map) { layer.update(input.getSnapshot()); layer.mount(map); },
    update() { layer.update(input.getSnapshot()); },
    subscribeInputs: input.subscribe,
    unmount: () => layer.unmount(),
  };
}
