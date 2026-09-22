import type { LayerStore } from '../../core/layers/store';
import type { MetarLayerSnapshot } from './metar/layer';
export type MetarApi = { readonly reports: LayerStore<MetarLayerSnapshot> };
