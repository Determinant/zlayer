import { useState } from 'react';
import type { PanelLayer } from './product';
import { ErrorBoundary } from './error-boundary';
import { PanelDefaults, usePanelSide } from '../ui/edge-panels';

export function LayerPanels({ layers }: { layers: readonly PanelLayer[] }) {
  const side = usePanelSide();
  const ids = new Set<string>();
  for (const layer of layers) {
    if (ids.has(layer.definition.id)) throw new Error(`Duplicate panel layer: ${layer.definition.id}`);
    ids.add(layer.definition.id);
  }
  return layers.filter(layer => !side || layer.panel.side === side)
    .map(layer => <LayerPanel key={layer.definition.id} layer={layer} />);
}

function LayerPanel({ layer: { definition, panel, Panel, close } }: { layer: PanelLayer }) {
  const [attempt, setAttempt] = useState(0);
  const retry = () => setAttempt(value => value + 1);
  return (
    <ErrorBoundary key={attempt} fallback={error => (
      <div className="product-panel-error" role="alert">
        <strong>{definition.title} unavailable</strong>
        <span>{error.message}</span>
        <div>
          <button type="button" onClick={retry}>Retry</button>
          <button type="button" onClick={() => window.location.reload()}>Reload app</button>
          {close && <button type="button" onClick={() => { close(); retry(); }}>Close</button>}
        </div>
      </div>
    )}>
      <PanelDefaults value={{ ...panel, name: definition.id, label: definition.title }}><Panel /></PanelDefaults>
    </ErrorBoundary>
  );
}
