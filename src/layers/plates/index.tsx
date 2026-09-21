import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import type { PanelLayer } from '../../core/layers/product';
import { useLayerSnapshot } from '../../core/layers/use-snapshot';
import { createPlatesController, type PlatesController } from './layer';
import { ProcedureDialog, ProcedureLoading } from './viewer-dialog';
import { PlateMapMenu } from './map-menu';
import { retainActiveFiles } from '../../offline/active-catalogs';
import { formatDateRange } from '../../core/format/time';

export function createPlatesLayer() {
  const controller = createPlatesController(true);
  return {
    ...controller,
    panel: { side: 'right', tab: { edge: 'bottom', order: 0 } },
    Panel: () => <PlatesPanel layer={controller} />,
    MapControl: () => <PlateMapControl layer={controller} />,
  } satisfies PanelLayer & PlatesController & { MapControl: () => React.JSX.Element };
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
  const { mapImage, mapMenuPoint, mapSelection, mapRestoreError } = useLayerSnapshot(layer);
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
      {mapRestoreError && <button type="button" className="plate-map-retry" onClick={layer.retryMapRestore}>Retry IAP</button>}
      <button type="button" onClick={() => layer.hideFromMap(mapImage)} aria-label="Hide IAP from map" title="Hide IAP from map">×</button>
    </aside>}
    {mapImage && mapMenuPoint && <PlateMapMenu point={mapMenuPoint} onClose={layer.closeMapMenu}
      onHide={() => layer.hideFromMap(mapImage)} />}
  </>;
}

export { AirportPlates } from './airport-plates';
export type { ProcedureSelection } from './data';
export { fetchOfflinePlateIndex, withRegionPlates, type OfflinePlateIndex } from './offline';
export { cacheProcedureDocument } from './document-cache';
