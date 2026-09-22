import { useContext, type CSSProperties, type ReactNode } from 'react';
import { EdgePanelFrame, PanelDefaults, useEdgePanel, type PanelStowGuard } from './edge-panels';

/** The host supplies tab placement; feature bodies supply content and dimensions. */
export function ToolPanel({ icon, beforeStow, children, className = '' }: {
  icon: ReactNode; beforeStow?: PanelStowGuard;
  children: ReactNode | ((visible: boolean) => ReactNode); className?: string;
}) {
  const placement = useContext(PanelDefaults);
  if (!placement) throw new Error('Tool panel requires a host placement');
  const panel = useEdgePanel(placement.name, { ...(beforeStow ? { beforeStow } : {}) });
  const offset = placement.tab.order * 48;
  const top = placement.tab.edge === 'top' ? (placement.bodyFromTop ? 0 : offset) : undefined;
  const style = {
    top: top ?? 'auto', bottom: placement.tab.edge === 'bottom' ? offset : 'auto',
    alignItems: placement.tab.edge === 'bottom' ? 'flex-end' : 'flex-start',
    '--edge-tool-top': `${top ?? offset}px`,
    '--edge-tab-offset': `${placement.bodyFromTop ? offset : 0}px`,
  } as CSSProperties;
  return <EdgePanelFrame panel={panel} label={placement.label} icon={icon}
    tab={placement.tab} style={style} className={`map-edge-tool ${className}`}>
    <div {...panel.bodyProps} className="map-edge-content edge-panel-body panel-scroll" tabIndex={-1}>
      {typeof children === 'function' ? children(panel.open) : children}
    </div>
  </EdgePanelFrame>;
}
