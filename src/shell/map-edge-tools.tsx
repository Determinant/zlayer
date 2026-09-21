import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { usePersistentState } from '../core/ui/use-persistent-state';
import { EdgePanels, EdgePanelFrame, useEdgePanel, type PanelStowGuard } from '../core/ui/edge-panels';
import '../core/ui/confirmation-dialog.css';
import './map-edge-tools.css';

type Tool = 'charts' | 'gps' | 'terrain' | 'ahrs';
const labels: Record<Tool, string> = { charts: 'chart status', gps: 'GPS status', terrain: 'terrain toolbox', ahrs: 'AHRS toolbox' };
const icons: Record<Tool, ReactNode> = {
  charts: <><path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2Z" /><path d="M9 3v16M15 5v16" /></>,
  gps: <><circle cx="12" cy="12" r="6" /><path d="M12 2v4m0 12v4M2 12h4m12 0h4" /><circle cx="12" cy="12" r="1" /></>,
  terrain: <><path d="m2 20 7-14 5 9 3-5 5 10ZM6 12l3 2 3-2" /></>,
  ahrs: <><circle cx="12" cy="12" r="9" /><path d="M3 12h5l2 2h4l2-2h5M12 3v3m-4 2h8" /></>,
};

/** Keep the slim overlays mounted while they tuck away beyond the map edge. */
export function MapEdgeTools({ charts, gps, terrain, ahrs, children }: {
  charts: ReactNode; gps?: ReactNode; terrain?: ReactNode;
  ahrs?: { render(visible: boolean): ReactNode; stop(): void };
  children?: ReactNode;
}) {
  const [active, setActive] = usePersistentState<string | null>('edge-tool', 'terrain',
    (value): value is string | null => value === null || typeof value === 'string' && Object.hasOwn(labels, value));
  const [stow, setStow] = useState<{ next: string | null; proceed: () => boolean } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    if (stow) dialog.current?.showModal();
    else dialog.current?.close();
  }, [stow]);
  const confirmStow = (mode: 'stop' | 'background') => {
    if (!stow) return;
    if (!stow.proceed()) { setStow(null); return; }
    if (mode === 'stop') ahrs?.stop();
    const target = stow.next ?? 'ahrs';
    dialog.current?.close();
    setStow(null);
    requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>(`[data-edge-tab="${target}"] .map-edge-handle`)?.focus());
  };
  return <div ref={root} className="map-edge-tools">
    <EdgePanels side="left" active={active} onActiveChange={setActive} individualTabs>
      {([['charts', charts], ['gps', gps], ['ahrs', ahrs?.render], ['terrain', terrain]] as const).map(([name, content]) => content &&
        <EdgeTool key={name} name={name}
          beforeStow={name === 'ahrs' ? (next, proceed) => { setStow({ next, proceed }); return false; } : undefined}>
          {typeof content === 'function' ? content(active === name) : content}
        </EdgeTool>)}
      {children}
    </EdgePanels>
    <dialog ref={dialog} className="confirmation-dialog ahrs-stow-dialog" role="alertdialog"
      aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
      onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}
      onCancel={event => { event.preventDefault(); event.stopPropagation(); setStow(null); }}>
      <h2 id={`${id}-title`}>Stow AHRS?</h2>
      <p id={`${id}-description`}>Stop motion sensing and recording to save power; you'll need to calibrate again. Background keeps AHRS running while stowed.</p>
      <div className="confirmation-actions ahrs-stow-actions">
        <button type="button" className="confirmation-primary ahrs-stow-stop" autoFocus onClick={() => confirmStow('stop')}>Stop</button>
        <button type="button" onClick={() => confirmStow('background')}>Background</button>
        <button type="button" onClick={() => setStow(null)}>Cancel</button>
      </div>
    </dialog>
  </div>;
}

function EdgeTool({ name, beforeStow, children }: {
  name: Tool; beforeStow?: PanelStowGuard | undefined; children: ReactNode;
}) {
  const panel = useEdgePanel(name, { beforeStow });
  return <EdgePanelFrame panel={panel} label={labels[name]} icon={icons[name]} className={`map-edge-tool map-edge-${name}`}>
    <div {...panel.bodyProps} className="map-edge-content edge-panel-body panel-scroll" tabIndex={-1}>{children}</div>
  </EdgePanelFrame>;
}
