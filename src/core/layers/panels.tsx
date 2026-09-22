import { memo, useState } from 'react';
import type { PanelContribution } from './plugin';
import { panelPlacement, validatePanelLayout, type PanelLayout } from './panel-layout';
import { ErrorBoundary } from './error-boundary';
import { PanelDefaults, usePanelSide, type PanelPlacement } from '../ui/edge-panels';

export const LayerPanels = memo(function LayerPanels({ panels, layout }: { panels: readonly PanelContribution[]; layout: PanelLayout }) {
  const side = usePanelSide();
  validatePanelLayout(layout);
  const ids = new Set<string>();
  for (const panel of panels) {
    if (ids.has(panel.id)) throw new Error(`Duplicate panel contribution: ${panel.id}`);
    ids.add(panel.id);
    panelPlacement(layout, panel.id);
  }
  // The host table also keeps keyboard/DOM order stable across registration order.
  const order = Object.keys(layout);
  return panels.filter(panel => !side || panelPlacement(layout, panel.id).side === side)
    .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
    .map(panel => <LayerPanel key={panel.id} contribution={panel} placement={panelPlacement(layout, panel.id)} />);
});

function LayerPanel({ contribution: { id, title, Component, close }, placement }: {
  contribution: PanelContribution; placement: PanelPlacement;
}) {
  const [attempt, setAttempt] = useState(0);
  const retry = () => setAttempt(value => value + 1);
  return <ErrorBoundary key={attempt} fallback={error => (
    <div className="product-panel-error" role="alert">
      <strong>{title} unavailable</strong><span>{error.message}</span>
      <div><button type="button" onClick={retry}>Retry</button>
        <button type="button" onClick={() => window.location.reload()}>Reload app</button>
        {close && <button type="button" onClick={() => { close(); retry(); }}>Close</button>}
      </div>
    </div>
  )}>
    <PanelDefaults value={{ ...placement, name: id, label: title }}><Component /></PanelDefaults>
  </ErrorBoundary>;
}
