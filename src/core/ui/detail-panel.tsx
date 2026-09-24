import type { ReactNode } from 'react';
import { EdgePanelFrame, type PanelTab, type useEdgePanel } from './edge-panels';

/** Shared selected-feature frame: a fixed heading and close action above one
 * keyboard-scrollable body. Acquisition and selection remain with the caller. */
export function DetailPanel({ panel, label, title, titleHint, icon, tab, onClose, closeLabel,
  actions, header, contentLabel, wide = false, className = '', bodyClassName = '', children }: {
  panel: ReturnType<typeof useEdgePanel>; label: string; title: string; titleHint?: string | undefined;
  icon: ReactNode; tab?: PanelTab; onClose(): void; closeLabel: string;
  actions?: ReactNode; header?: ReactNode; contentLabel: string; wide?: boolean;
  className?: string; bodyClassName?: string; children: ReactNode;
}) {
  return <EdgePanelFrame panel={panel} label={label} icon={icon} {...(tab ? { tab } : {})}
    className={`detail-panel${wide ? ' detail-panel--wide' : ''} ${className}`}>
    <article {...panel.bodyProps} className={`feature-card edge-panel-body ${bodyClassName}`}>
      <button className="ui-button ui-button--quiet ui-button--compact ui-button--icon close-card" type="button"
        aria-label={closeLabel} onClick={() => panel.close(onClose)}>×</button>
      <div className="feature-card-heading">
        <h2 title={titleHint}>{title}</h2>
        {actions && <div className="feature-card-actions">{actions}</div>}
      </div>
      {header && <div className="feature-card-header">{header}</div>}
      <div className="feature-card-content panel-scroll" role="region" tabIndex={0} aria-label={contentLabel}>
        {children}
      </div>
    </article>
  </EdgePanelFrame>;
}
