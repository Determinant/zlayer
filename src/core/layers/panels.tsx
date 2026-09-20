import { useState } from 'react';
import type { PanelLayer } from './product';
import { ErrorBoundary } from './error-boundary';

export function LayerPanels({ layers }: { layers: readonly PanelLayer[] }) {
  return layers.map(layer => <LayerPanel key={layer.definition.id} layer={layer} />);
}

function LayerPanel({ layer: { definition, Panel, close } }: { layer: PanelLayer }) {
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
      <Panel />
    </ErrorBoundary>
  );
}
