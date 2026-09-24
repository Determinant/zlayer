import { useContext, type CSSProperties, type ReactNode } from 'react';
import { EdgePanelFrame, PanelDefaults, useEdgePanel, type PanelStowGuard } from './edge-panels';

/** The host supplies tab placement; feature bodies supply content and dimensions. */
export function ToolPanel({ icon, beforeStow, children, className = '' }: {
  icon: ReactNode; beforeStow?: PanelStowGuard;
  children: ReactNode | ((visible: boolean, panel: ReturnType<typeof useEdgePanel>) => ReactNode); className?: string;
}) {
  const placement = useContext(PanelDefaults);
  if (!placement) throw new Error('Tool panel requires a host placement');
  const panel = useEdgePanel(placement.name, { ...(beforeStow ? { beforeStow } : {}) });
  const offset = placement.tab.order * 48;
  const bottom = placement.tab.edge === 'bottom';
  const bodyOffset = placement.bodyFromEdge ? 0 : offset;
  const tabOffset = placement.bodyFromEdge ? offset : 0;
  const style = {
    top: bottom ? 'auto' : bodyOffset, bottom: bottom ? bodyOffset : 'auto',
    alignItems: bottom ? 'flex-end' : 'flex-start',
    '--edge-tool-offset': `${bodyOffset}px`,
    '--edge-tab-top': `${bottom ? 0 : tabOffset}px`,
    '--edge-tab-bottom': `${bottom ? tabOffset : 0}px`,
    '--edge-tool-inset': bottom ? 'var(--edge-bottom-inset, 0px)' : '0px',
  } as CSSProperties;
  return <EdgePanelFrame panel={panel} label={placement.label} icon={icon}
    tab={placement.tab} style={style} className={`map-edge-tool ${className}`}>
    <div {...panel.bodyProps} className="map-edge-content edge-panel-body panel-scroll" tabIndex={-1}>
      {typeof children === 'function' ? children(panel.open, panel) : children}
    </div>
  </EdgePanelFrame>;
}
