import type { ReactNode } from 'react';
import { usePersistentState } from '../core/ui/use-persistent-state';
import { EdgePanels } from '../core/ui/edge-panels';
import type { PanelLayout } from '../core/layers/panel-layout';
import './map-edge-tools.css';

/** Layout and disclosure belong to the shell; feature bodies remain mounted. */
export function MapEdgeTools({ layout, children }: { layout: PanelLayout; children: ReactNode }) {
  const [active, setActive] = usePersistentState<string | null>('edge-tool', null,
    (value): value is string | null => value === null || typeof value === 'string' && layout[value]?.side === 'left');
  return <div className="map-edge-tools">
    <EdgePanels side="left" active={active} onActiveChange={setActive} individualTabs>{children}</EdgePanels>
  </div>;
}
