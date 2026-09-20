import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { usePersistentState } from '../core/ui/use-persistent-state';
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
export function MapEdgeTools({ charts, gps, terrain, ahrs }: {
  charts: ReactNode; gps?: ReactNode; terrain?: ReactNode;
  ahrs?: { render(visible: boolean): ReactNode; stop(): void };
}) {
  const [active, setActive] = usePersistentState<Tool | null>('edge-tool', 'terrain',
    (value): value is Tool | null => value === null || value === 'charts' || value === 'gps' || value === 'terrain' || value === 'ahrs');
  const [stow, setStow] = useState<{ next: Tool | null } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    if (stow) dialog.current?.showModal();
    else dialog.current?.close();
  }, [stow]);
  const toggle = (name: Tool) => {
    const next = active === name ? null : name;
    if (active === 'ahrs') { setStow({ next }); return false; }
    setActive(next);
    return true;
  };
  const confirmStow = (mode: 'stop' | 'background') => {
    if (!stow) return;
    if (mode === 'stop') ahrs?.stop();
    const target = stow.next ?? 'ahrs';
    dialog.current?.close();
    setActive(stow.next);
    setStow(null);
    requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>(`.map-edge-${target} .map-edge-handle`)?.focus());
  };
  return <div ref={root} className="map-edge-tools">
    {([['charts', charts], ['gps', gps], ['ahrs', ahrs?.render], ['terrain', terrain]] as const).map(([name, content]) => content &&
      <EdgeTool key={name} name={name} open={active === name}
        onToggle={() => toggle(name)}>
        {typeof content === 'function' ? content(active === name) : content}
      </EdgeTool>)}
    <dialog ref={dialog} className="ahrs-stow-dialog" role="alertdialog"
      aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
      onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}
      onCancel={event => { event.preventDefault(); event.stopPropagation(); setStow(null); }}>
      <h2 id={`${id}-title`}>Stow AHRS?</h2>
      <p id={`${id}-description`}>Stop motion sensing and recording to save power; you'll need to calibrate again. Background keeps AHRS running while stowed.</p>
      <div className="ahrs-stow-actions">
        <button type="button" className="ahrs-stow-stop" autoFocus onClick={() => confirmStow('stop')}>Stop</button>
        <button type="button" onClick={() => confirmStow('background')}>Background</button>
        <button type="button" onClick={() => setStow(null)}>Cancel</button>
      </div>
    </dialog>
  </div>;
}

function EdgeTool({ name, open, onToggle, children }: {
  name: Tool; open: boolean; onToggle: () => boolean; children: ReactNode;
}) {
  const id = useId();
  const handle = useRef<HTMLButtonElement>(null);
  const actionLabel = `${open ? 'Hide' : 'Show'} ${labels[name]}`;
  return <div className={`map-edge-tool map-edge-${name}${open ? ' is-open' : ''}`}
    onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onKeyDown={event => {
      if (event.key === 'Escape' && open) {
        event.stopPropagation();
        // Let a field's Escape handler discard its draft before focus triggers blur.
        if (onToggle()) requestAnimationFrame(() => handle.current?.focus());
        // The same Escape must not immediately cancel the confirmation it opens.
        else event.preventDefault();
      }
    }}>
    <button ref={handle} type="button" className="map-edge-handle" aria-controls={id} aria-expanded={open}
      aria-label={actionLabel} title={actionLabel}
      onClick={onToggle}>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{icons[name]}</svg>
    </button>
    <div id={id} className="map-edge-content panel-scroll" tabIndex={-1} inert={!open} aria-hidden={!open}>{children}</div>
  </div>;
}
