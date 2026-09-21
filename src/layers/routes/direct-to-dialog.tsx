import { useId, useLayoutEffect, useRef } from 'react';
import type { DirectToConfirmation } from './use-direct-to';
import '../../core/ui/confirmation-dialog.css';

export function DirectToDialog({ confirmation }: { confirmation: DirectToConfirmation | undefined }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const id = useId();
  const open = !!confirmation;
  useLayoutEffect(() => {
    if (open) { dialog.current?.showModal(); cancel.current?.focus(); }
    else dialog.current?.close();
  }, [open]);
  return <dialog ref={dialog} className="confirmation-dialog direct-to-dialog" role="alertdialog"
    aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
    onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onKeyDown={event => event.stopPropagation()}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); confirmation?.cancel(); }}>
    <h2 id={`${id}-title`}>{confirmation?.problem ? `Cannot go direct to ${confirmation.ident}` : `Direct to ${confirmation?.ident}?`}</h2>
    <p id={`${id}-description`}>{confirmation?.problem
      ? `${confirmation.problem} Your route has not changed.`
      : `This will clear the current route and go directly to ${confirmation?.ident} from your current GPS position.`}</p>
    {confirmation && !confirmation.problem && !confirmation.available && <p role="status">Waiting for a fresh GPS fix.</p>}
    <div className="confirmation-actions">
      {!confirmation?.problem && <button type="button" className="confirmation-primary" disabled={!confirmation?.available}
        onClick={() => confirmation?.confirm()}>Direct to</button>}
      <button ref={cancel} type="button" onClick={() => confirmation?.cancel()}>{confirmation?.problem ? 'Close' : 'Cancel'}</button>
    </div>
  </dialog>;
}
