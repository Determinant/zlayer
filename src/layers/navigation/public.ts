import type { FeatureCollectionResponse } from '@zlayer/contracts';
import type { LayerStore } from '../../core/layers/store';

export type NavigationApi = {
  readonly airports: LayerStore<{ data: FeatureCollectionResponse | undefined; visible: boolean }>;
};
