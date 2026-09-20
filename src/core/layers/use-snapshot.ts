import { useSyncExternalStore } from 'react';
import type { LayerStore } from './store';

/** React observes a layer; mounting, fetching and rendering belong to the module. */
export function useLayerSnapshot<T>(store: LayerStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
