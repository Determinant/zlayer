import type { ReactNode, Ref } from 'react';

export function EdgeHandle({ ref, controls, open, label, side = 'left', onClick, children }: {
  ref?: Ref<HTMLButtonElement>; controls: string; open: boolean; label: string;
  side?: 'left' | 'right'; onClick: () => void; children: ReactNode;
}) {
  const actionLabel = `${open ? 'Hide' : 'Show'} ${label}`;
  return <button ref={ref} type="button" className={`map-edge-handle${side === 'right' ? ' is-right' : ''}`}
    aria-controls={controls} aria-expanded={open} aria-label={actionLabel} title={actionLabel} onClick={onClick}
    onKeyDown={event => {
      if (event.key !== 'Tab' || event.shiftKey || !open) return;
      const panel = document.getElementById(controls);
      if (!panel) return;
      const button = event.currentTarget;
      event.preventDefault();
      const enter = () => {
        if (!button.isConnected || document.activeElement !== button || button.getAttribute('aria-expanded') !== 'true') return;
        // A switch first stows the previous panel. Preserve keyboard intent
        // while the requested panel is still waiting to enter.
        if (panel.inert || getComputedStyle(panel).visibility === 'hidden') { requestAnimationFrame(enter); return; }
        const first = Array.from(panel.querySelectorAll<HTMLElement>(
          'button, a[href], input, select, textarea, [tabindex]')).find(element =>
          element.tabIndex >= 0 && !element.matches(':disabled') && getComputedStyle(element).visibility !== 'hidden' && element.getClientRects().length > 0);
        first?.focus({ preventScroll: true });
      };
      enter();
    }}>
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
  </button>;
}
