import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';

/** The same viewport-filling, top-layer mode as plates. Keep one DOM tree in
 * both modes so toggling cannot reset calibration, display filters or HSI state. */
export function AhrsWindow({ expanded, onExit, button, children }: {
  expanded: boolean; onExit: () => void; button: RefObject<HTMLButtonElement | null>; children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const previous = useRef(false);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    if (expanded) {
      dialog.close();
      dialog.showModal();
      button.current?.focus({ preventScroll: true });
    } else {
      if (previous.current) dialog.close();
      // Non-modal inline mode retains the same children and their state.
      if (!dialog.open) dialog.setAttribute('open', '');
      if (previous.current) button.current?.focus({ preventScroll: true });
    }
    previous.current = expanded;
  }, [expanded, button]);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    return () => dialog.close();
  }, []);
  return <dialog ref={ref} open className={`ahrs-window${expanded ? ' is-fullscreen' : ''}`}
    role={expanded ? 'dialog' : 'presentation'} aria-label={expanded ? 'AHRS full screen' : undefined}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); if (expanded) onExit(); }}
    onKeyDown={event => { if (expanded && event.key === 'Escape') event.stopPropagation(); }}>
    {children}
  </dialog>;
}

/** Match the plate viewer's expand/contract icon, label and pressed state. */
export function AhrsFullScreenButton({ expanded, onClick, button }: {
  expanded: boolean; onClick: () => void; button: RefObject<HTMLButtonElement | null>;
}) {
  return <button ref={button} type="button" className="ahrs-header-button ahrs-fullscreen-button" onClick={onClick}
    aria-label={expanded ? 'Exit full screen' : 'Enter full screen'}
    title={expanded ? 'Exit full screen' : 'Enter full screen'} aria-pressed={expanded}>
    <svg width={expanded ? 20 : 14} height={expanded ? 20 : 14} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={expanded
        ? 'M3 9h6V3m6 0v6h6M3 15h6v6m6 0v-6h6'
        : 'M9 3H3v6m12-6h6v6M3 15v6h6m6 0h6v-6'} />
    </svg>
  </button>;
}
