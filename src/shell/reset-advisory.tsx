import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { beginReset } from '../core/storage/reset';
import { useModalDialog } from '../core/ui/use-modal-dialog';
import { pwaUpdates } from '../pwa-updates';
import '../core/ui/confirmation-dialog.css';

export function ResetAdvisory({ id, updating }: { id: string; updating: boolean }) {
  const keep = useRef<HTMLButtonElement>(null);
  const dialog = useModalDialog(true, keep);
  const label = useId();
  const [error, setError] = useState<string>();
  return createPortal(<dialog ref={dialog} className="confirmation-dialog reset-advisory" role="alertdialog"
    aria-labelledby={`${label}-title`} aria-describedby={`${label}-reason ${label}-effect`}
    onCancel={event => { event.preventDefault(); pwaUpdates.dismissAdvisory(); }}>
    <h2 id={`${label}-title`}>Reset app data?</h2>
    <p id={`${label}-reason`}>ZLayer is still in development, and this update changes saved data formats.
      {' '}{id === 'artcc-2026-10' ? 'Reset now so older offline data won’t hide FIR information.'
        : 'We recommend a reset to avoid missing or incorrect displays.'}</p>
    <p id={`${label}-effect`}>This deletes all local downloads, routes, recordings and preferences, and stops other ZLayer windows.
      {' '}You’ll need a connection to reopen the app and download your regions again.</p>
    {error && <p role="alert">{error}</p>}
    <div className="confirmation-actions">
      <button className="ui-button ui-button--danger" type="button" onClick={() => {
        try { beginReset(); }
        catch (error) { setError(error instanceof Error ? error.message : 'Could not start the reset. Try again.'); }
      }}>Reset now</button>
      <button className="ui-button" type="button" ref={keep} onClick={pwaUpdates.keepData}>
        {updating ? 'Keep data and update' : 'Keep my data'}
      </button>
    </div>
  </dialog>, document.body);
}
