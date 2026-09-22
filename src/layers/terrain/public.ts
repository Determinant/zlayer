import type { LayerStore } from '../../core/layers/store';
import type { TerrainStatus } from './types';
export type TerrainApi = { readonly status: LayerStore<TerrainStatus> };
