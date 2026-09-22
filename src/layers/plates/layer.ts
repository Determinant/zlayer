import { createLayerStore } from '../../core/layers/store';
import type { ProductLayer } from '../../core/layers/product';
import type { ProcedureSelection } from './data';
import { plateSelectionRecord, mappedPlateRecord } from './persistence';
import type { PlateMapImage } from './map-image';

export type PlatesSnapshot = {
  selection: ProcedureSelection | undefined;
  requestId: number;
  mapImage?: PlateMapImage;
  mapSelection?: ProcedureSelection;
  mapImageRestored?: boolean;
  mapRestoreError?: string;
  mapMenuPoint?: { x: number; y: number };
};

/** Selection belongs to the plates product, independently of the map or airport card. */
export function createPlatesController(persist = false) {
  const restored = persist ? plateSelectionRecord.read() : null;
  const mapped = persist ? mappedPlateRecord.read() : null;
  const store = createLayerStore<PlatesSnapshot>({ selection: restored ?? undefined, requestId: 0,
    ...(mapped ? { mapSelection: mapped } : {}) });
  let restoration: AbortController | undefined;
  return {
    definition: { id: 'plates', title: 'Plates' } satisfies ProductLayer['definition'],
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    /** Release live rendering without deleting the selected document or its saved intent. */
    dispose() {
      restoration?.abort(); restoration = undefined;
      const { mapImage, mapMenuPoint: _menu, mapRestoreError: _error, ...current } = store.getSnapshot();
      if (mapImage) mapImage.canvas.width = mapImage.canvas.height = 0;
      store.publish({ ...current, requestId: current.requestId + 1 });
    },
    open(selection: ProcedureSelection) {
      if (persist) plateSelectionRecord.write(selection);
      const { mapMenuPoint: _closed, ...current } = store.getSnapshot();
      store.publish({ ...current, selection, requestId: current.requestId + 1 });
    },
    close(requestId?: number) {
      const current = store.getSnapshot();
      if (!current.selection || (requestId !== undefined && requestId !== current.requestId)) return;
      if (persist) plateSelectionRecord.write(null);
      store.publish({ ...current, selection: undefined });
    },
    showOnMap(image: PlateMapImage, requestId: number) {
      const current = store.getSnapshot();
      if (!current.selection || current.requestId !== requestId) {
        image.canvas.width = image.canvas.height = 0;
        return;
      }
      restoration?.abort();
      if (persist) {
        mappedPlateRecord.write(image.selection);
        plateSelectionRecord.write(null);
      }
      const { mapMenuPoint: _closed, mapRestoreError: _error, ...next } = current;
      store.publish({ ...next, selection: undefined, mapImage: image, mapSelection: image.selection, mapImageRestored: false });
      if (current.mapImage && current.mapImage !== image) current.mapImage.canvas.width = current.mapImage.canvas.height = 0;
    },
    /** Renderers are lazy and cancellable; a stale restore must never replace a user's new plate. */
    restoreOnMap(load: (selection: ProcedureSelection, signal: AbortSignal) => Promise<PlateMapImage>) {
      const { mapSelection, mapImage } = store.getSnapshot();
      if (!mapSelection || mapImage) return () => {};
      restoration?.abort();
      const controller = new AbortController();
      restoration = controller;
      void (async () => load(mapSelection, controller.signal))().then(image => {
        const current = store.getSnapshot();
        if (controller.signal.aborted || current.mapSelection !== mapSelection) {
          image.canvas.width = image.canvas.height = 0;
          return;
        }
        const { mapRestoreError: _error, ...next } = current;
        store.publish({ ...next, mapImage: image, mapImageRestored: true });
      }).catch((error: unknown) => {
        if (controller.signal.aborted || store.getSnapshot().mapSelection !== mapSelection) return;
        store.publish({ ...store.getSnapshot(), mapRestoreError:
          error instanceof Error && error.message ? error.message : 'Unable to restore this plate.' });
      }).finally(() => {
        if (restoration === controller) restoration = undefined;
      });
      return () => controller.abort();
    },
    retryMapRestore() {
      const { mapRestoreError, ...next } = store.getSnapshot();
      if (mapRestoreError) store.publish(next);
    },
    openMapMenu(image: PlateMapImage, point: { x: number; y: number }) {
      const current = store.getSnapshot();
      if (image !== current.mapImage) return;
      store.publish({ ...current, mapMenuPoint: { x: point.x, y: point.y } });
    },
    closeMapMenu() {
      const current = store.getSnapshot();
      if (!current.mapMenuPoint) return;
      const { mapMenuPoint: _closed, ...next } = current;
      store.publish(next);
    },
    hideFromMap(image = store.getSnapshot().mapImage) {
      const current = store.getSnapshot();
      if ((image && image !== current.mapImage) || (!current.mapSelection && !current.mapImage)) return;
      restoration?.abort();
      if (persist) mappedPlateRecord.write(null);
      const { mapImage: _removed, mapMenuPoint: _closed, mapSelection: _selection,
        mapImageRestored: _restored, mapRestoreError: _error, ...next } = current;
      store.publish(next);
      if (image) image.canvas.width = image.canvas.height = 0;
    },
  };
}
export type PlatesController = ReturnType<typeof createPlatesController>;
