import type { PlatesApi } from './public';
import { createLayerEvents } from '../../core/layers/events';
import type { PluginExports } from '../../core/layers/bridge';
import { pluginStorage } from './storage';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import type { LayerPlugin } from '../../core/layers/plugin';
import { useLayerSnapshot } from '../../core/layers/use-snapshot';
import { createPlatesController, type PlatesController } from './layer';
import { ProcedureDialog, ProcedureLoading } from './viewer-dialog';
import type { PlateMapImage } from './map-image';
import { retainActiveFiles } from '../../offline/active-catalogs';
import { formatDateRange } from '../../core/format/time';

export function createPlatesLayer() {
  const controller = createPlatesController(true);
  const opened = createLayerEvents<Parameters<PlatesApi['open']>[0]>();
  const open: PlatesApi['open'] = selection => { controller.open(selection); opened.emit(selection); };
  const Panel = () => <PlatesPanel layer={controller} />;
  const MapControl = () => <PlateMapControl layer={controller} />;
  let imageAt: ((point: { x: number; y: number }) => PlateMapImage | undefined) | undefined;
  return {
    ...controller,
    publicApi(scope) {
      return {
        open: scope.command(open),
        contextActions: scope.command(point => {
          const image = imageAt?.(point);
          return image ? [
            { id: 'plates:open', label: 'Show plate panel', select: scope.command(() => {
              if (controller.getSnapshot().mapImage === image) open(image.selection);
            }) },
            { id: 'plates:hide', label: 'Hide IAP from map', select: scope.command(() => controller.hideFromMap(image)) },
          ] : [];
        }),
        opened: { subscribe: listener => scope.listen(opened.events, listener) },
      };
    },
    storage: pluginStorage,
    panels: [{ id: 'plate', title: controller.definition.title, Component: Panel, close: controller.close }],
    overlays: [{ id: 'plate-map', Component: MapControl }],
    mapContribution: { id: 'plates', async load(context) {
      const initiallyFitted = context.preserveView ? controller.getSnapshot().mapImage : undefined;
      const { createPlateMapLayer } = await import('./map');
      const layer = createPlateMapLayer(controller, initiallyFitted);
      return [{ ...layer, mount(map) { layer.mount(map); imageAt = layer.imageAt; },
        unmount() { imageAt = undefined; layer.unmount(); } }];
    } },
  } satisfies LayerPlugin & PluginExports<PlatesApi>;
}

function PlatesPanel({ layer }: { layer: PlatesController }) {
  // Remounting clears React's lazy rejection. A browser-cached module failure
  // needs the panel error screen's Reload app action.
  const [ProcedureViewer] = useState(() => lazy(() => import('./viewer')));
  const { selection, requestId } = useLayerSnapshot(layer);
  const close = useCallback(() => layer.close(requestId), [layer, requestId]);
  if (!selection) return null;
  return (
    <ProcedureDialog key={requestId} selection={selection} onClose={close}>
      <Suspense fallback={<ProcedureLoading source={selection.document} />}>
        <ProcedureViewer selection={selection} onShowOnMap={image => layer.showOnMap(image, requestId)} />
      </Suspense>
    </ProcedureDialog>
  );
}

function PlateMapControl({ layer }: { layer: PlatesController }) {
  const { mapImage, mapSelection, mapRestoreError } = useLayerSnapshot(layer);
  useEffect(() => {
    if (!mapSelection) return;
    return retainActiveFiles([mapSelection.document.url]);
  }, [mapSelection]);
  useEffect(() => {
    if (!mapSelection || mapImage || mapRestoreError) return;
    return layer.restoreOnMap(async (selection, signal) => {
      const { restorePlateMapImage } = await import('./restore-map-image');
      signal.throwIfAborted();
      return restorePlateMapImage(selection, signal);
    });
  }, [layer, mapSelection, mapImage, mapRestoreError]);
  if (!mapSelection) return null;
  return <>
    {!mapImage && <aside className="plate-map-control" aria-label="IAP on map" aria-busy={!mapRestoreError}>
      <span><strong>{mapSelection.airport.id} · {mapSelection.procedure.name}</strong>
        <small>Effective {formatDateRange(mapSelection.effectiveDate, mapSelection.expirationDate)}</small>
        {mapRestoreError ? <small role="alert" title={mapRestoreError}>IAP could not be restored. Retry or hide it.</small>
          : <small>Restoring IAP…</small>}</span>
      {mapRestoreError && <button type="button" className="ui-button plate-map-retry" onClick={layer.retryMapRestore}>Retry IAP</button>}
      <button className="ui-button ui-button--icon" type="button" onClick={() => layer.hideFromMap(mapImage)} aria-label="Hide IAP from map" title="Hide IAP from map">×</button>
    </aside>}
  </>;
}

export { AirportPlates } from './airport-plates';
export type { ProcedureSelection } from './data';
export { fetchOfflinePlateIndex, withRegionPlates, type OfflinePlateIndex } from './offline';
export { cacheProcedureDocument } from './document-cache';
