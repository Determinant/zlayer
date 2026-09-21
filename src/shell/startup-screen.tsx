import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import './startup-screen.css';

export function StartupScreen({ message = 'Opening your workspace…', slow = false, onContinue }: {
  message?: string; slow?: boolean; onContinue?: (() => void) | undefined;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    const present = () => {
      dialog.showModal();
      title.current?.focus({ preventScroll: true });
    };
    present();
    // A restored full-screen plate can finish its lazy import during startup.
    // Keep the loading screen above late modal restores as they initialize.
    const observer = new MutationObserver(() => {
      const focusedModal = document.activeElement?.closest('dialog:modal');
      if (focusedModal && focusedModal !== dialog) { dialog.close(); present(); }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
    return () => { observer.disconnect(); dialog.close(); };
  }, []);
  return createPortal(<dialog ref={ref} className="startup-screen launch-state" aria-labelledby="startup-title"
    aria-describedby="startup-status" onCancel={event => event.preventDefault()}>
    <img className="brand-mark is-loading" src="/icon.svg" alt="" />
    <h1 ref={title} id="startup-title" tabIndex={-1}>ZLayer</h1>
    <p id="startup-status" role="status">{message}</p>
    {slow && <div className="startup-recovery">
      <p>{onContinue ? 'Taking longer than usual. You can open the workspace while loading continues.'
        : 'Taking longer than usual. You can reload to try again.'}</p>
      <button type="button" onClick={onContinue ?? (() => location.reload())}>
        {onContinue ? 'Open workspace' : 'Reload'}
      </button>
    </div>}
  </dialog>, document.body);
}
