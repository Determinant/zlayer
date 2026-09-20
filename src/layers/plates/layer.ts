import { createLayerStore } from '../../core/layers/store';
import type { ProductLayer } from '../../core/layers/product';
import type { ProcedureSelection } from './data';
import { readUiState, writeUiState } from '../../core/storage/ui-state';
import { isProcedureSelection } from './persistence';

export type PlatesSnapshot = { selection: ProcedureSelection | undefined; requestId: number };

/** Selection belongs to the plates product, independently of the map or airport card. */
export function createPlatesController(persist = false) {
  const restored = persist ? readUiState('plate-selection', null, isProcedureSelection) : null;
  const store = createLayerStore<PlatesSnapshot>({ selection: restored ?? undefined, requestId: 0 });
  return {
    definition: { id: 'plates', title: 'Plates' } satisfies ProductLayer['definition'],
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    open(selection: ProcedureSelection) {
      if (persist) writeUiState('plate-selection', selection);
      store.publish({ selection, requestId: store.getSnapshot().requestId + 1 });
    },
    close(requestId?: number) {
      const current = store.getSnapshot();
      if (!current.selection || (requestId !== undefined && requestId !== current.requestId)) return;
      if (persist) writeUiState('plate-selection', null);
      store.publish({ ...current, selection: undefined });
    },
  };
}
export type PlatesController = ReturnType<typeof createPlatesController>;
