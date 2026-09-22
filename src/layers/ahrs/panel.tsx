import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { RoutePlan } from '@zlayer/domain';
import type { AhrsLayer } from './layer';
import { AhrsTool } from './controls';
import { ToolPanel } from '../../core/ui/tool-panel';
import { focusPanelTab } from '../../core/ui/edge-panels';
import '../../core/ui/confirmation-dialog.css';

/** Sensor/recording policy belongs to AHRS; the panel host only defers the switch. */
export function AhrsPanel({ layer, route, revision }: { layer: AhrsLayer; route: RoutePlan; revision: string }) {
  const [stow, setStow] = useState<{ next: string | null; proceed: () => boolean } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    if (stow) dialog.current?.showModal();
    else dialog.current?.close();
  }, [stow]);
  const confirm = (mode: 'stop' | 'background') => {
    if (!stow) return;
    if (!stow.proceed()) { setStow(null); return; }
    if (mode === 'stop') layer.stop();
    const target = stow.next ?? 'ahrs';
    dialog.current?.close();
    setStow(null);
    focusPanelTab(target);
  };
  return <>
    <ToolPanel className="map-edge-ahrs" beforeStow={(next, proceed) => { setStow({ next, proceed }); return false; }}
      icon={<><circle cx="12" cy="12" r="9" /><path d="M3 12h5l2 2h4l2-2h5M12 3v3m-4 2h8" /></>}>
      {visible => <AhrsTool layer={layer} route={route} revision={revision} visible={visible} />}
    </ToolPanel>
    <dialog ref={dialog} className="confirmation-dialog ahrs-stow-dialog" role="alertdialog"
      aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
      onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}
      onCancel={event => { event.preventDefault(); event.stopPropagation(); setStow(null); }}>
      <h2 id={`${id}-title`}>Stow AHRS?</h2>
      <p id={`${id}-description`}>Stop motion sensing and recording to save power; you'll need to calibrate again. Background keeps AHRS running while stowed.</p>
      <div className="confirmation-actions ahrs-stow-actions">
        <button type="button" className="confirmation-primary ahrs-stow-stop" autoFocus onClick={() => confirm('stop')}>Stop</button>
        <button type="button" onClick={() => confirm('background')}>Background</button>
        <button type="button" onClick={() => setStow(null)}>Cancel</button>
      </div>
    </dialog>
  </>;
}
