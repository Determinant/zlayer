import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { LoadingPlaceholder } from '../core/ui/loading-placeholder';

export function SettingsDialog({ open, onClose, children }: {
  open: boolean; onClose: () => void; children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  // Open the parent before the nested About dialog's passive effect restores it.
  useLayoutEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);

  return <dialog ref={dialog} className="settings-dialog" aria-labelledby="settings-title"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="settings-heading">
      <div><span className="eyebrow">ZLayer</span><h2 id="settings-title">Settings</h2></div>
      <button type="button" onClick={onClose} aria-label="Close settings" autoFocus>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" focusable="false">
          <path d="m6 6 12 12M18 6 6 18" />
        </svg>
      </button>
    </header>
    {children}
  </dialog>;
}

export function SettingsLoading() {
  return <div className="settings-loading" aria-busy="true">
    <LoadingPlaceholder label="Loading settings…" />
  </div>;
}
