import { lazy, Suspense, useCallback, useState } from 'react';
import type { PanelLayer } from '../../core/layers/product';
import { useLayerSnapshot } from '../../core/layers/use-snapshot';
import { createPlatesController, type PlatesController } from './layer';
import { ProcedureDialog, ProcedureLoading } from './viewer-dialog';

export function createPlatesLayer() {
  const controller = createPlatesController(true);
  return {
    ...controller,
    Panel: () => <PlatesPanel layer={controller} />,
  } satisfies PanelLayer & PlatesController;
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
        <ProcedureViewer selection={selection} />
      </Suspense>
    </ProcedureDialog>
  );
}

export { AirportPlates } from './airport-plates';
export type { ProcedureSelection } from './data';
export { fetchOfflinePlateIndex, withRegionPlates, type OfflinePlateIndex } from './offline';
export { cacheProcedureDocument } from './document-cache';
