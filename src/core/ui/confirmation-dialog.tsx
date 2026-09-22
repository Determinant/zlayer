import { useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useModalDialog } from './use-modal-dialog';
import './confirmation-dialog.css';

/** Mount while confirmation is needed; unmounting closes it and restores focus. */
export function ConfirmationDialog({ title, description, confirmLabel, destructive = false, disabled = false, onConfirm, onCancel }: {
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  disabled?: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const dialog = useModalDialog(true, cancel);
  const id = useId();

  return createPortal(<dialog ref={dialog} className="confirmation-dialog" role="alertdialog"
    aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
    onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onKeyDown={event => event.stopPropagation()}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); onCancel(); }}>
    <h2 id={`${id}-title`}>{title}</h2>
    <p id={`${id}-description`}>{description}</p>
    <div className="confirmation-actions">
      <button type="button" className={`ui-button ui-button--${destructive ? 'danger' : 'primary'}`} disabled={disabled}
        onClick={() => { dialog.current?.close(); onConfirm(); }}>{confirmLabel}</button>
      <button className="ui-button" ref={cancel} type="button" autoFocus onClick={onCancel}>Cancel</button>
    </div>
  </dialog>, document.body);
}
