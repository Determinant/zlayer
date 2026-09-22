import type { LayerStore } from '../../core/layers/store';
import type { ObstructionStatus } from './types';
export type ObstructionApi = { readonly status: LayerStore<ObstructionStatus> };
