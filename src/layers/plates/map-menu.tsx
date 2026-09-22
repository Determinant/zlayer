import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useBackDismiss } from '../../core/ui/pwa-back';

export function PlateMapMenu({ point, onClose, onOpen, onHide }: {
  point: { x: number; y: number };
  onClose: () => void;
  onOpen: () => void;
  onHide: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const action = useRef<HTMLButtonElement>(null);
  const pressed = useRef<HTMLButtonElement | null>(null);
  const [position, setPosition] = useState(point);
  const [opener] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);

  useLayoutEffect(() => {
    action.current?.focus({ preventScroll: true });
  }, []);

  // Restore focus on explicit dismissal, not effect cleanup: StrictMode replays
  // cleanup while the menu is still open, and moving focus out would close it.
  const restoreFocus = () => { if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  useBackDismiss(true, ref, () => { onClose(); restoreFocus(); });

  useLayoutEffect(() => {
    const menu = ref.current!;
    const container = menu.offsetParent;
    if (!(container instanceof HTMLElement)) return;
    const place = () => {
      const next = {
        x: Math.max(12, Math.min(point.x + 10, container.clientWidth - menu.offsetWidth - 12)),
        y: Math.max(12, Math.min(point.y + 10, container.clientHeight - menu.offsetHeight - 12)),
      };
      setPosition(current => current.x === next.x && current.y === next.y ? current : next);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(container);
    observer.observe(menu);
    return () => observer.disconnect();
  }, [point.x, point.y]);

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', dismiss, true);
    return () => document.removeEventListener('pointerdown', dismiss, true);
  }, [onClose]);

  const actions = [
    { label: 'Show plate panel', select: onOpen, icon: 'M6 3h9l4 4v14H6ZM14 3v5h5M10 12h5m-5 4h5' },
    { label: 'Hide IAP from map', select: () => { onHide(); restoreFocus(); },
      icon: 'm3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.8 5.2A12 12 0 0 1 12 5c7 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.5 6.5A19 19 0 0 0 2 12s3 7 10 7a12 12 0 0 0 5.5-1.5' },
  ];

  return <div ref={ref} className="plate-map-menu" style={{ left: position.x, top: position.y }}
    role="menu" aria-label="IAP actions"
    onContextMenu={event => event.preventDefault()}
    onBlur={event => {
      if (event.relatedTarget !== null && !event.currentTarget.contains(event.relatedTarget as Node)) onClose();
    }}
    onKeyDown={event => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); onClose(); restoreFocus();
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    }}>
    {actions.map((item, index) => <button key={item.label} ref={index === 0 ? action : undefined} type="button" role="menuitem"
      onPointerDown={event => { pressed.current = event.button === 0 ? event.currentTarget : null; }}
      onPointerCancel={() => { pressed.current = null; }}
      onClick={event => {
        // Releasing the long press over the new menu must not select its action.
        // Pointer activation requires a fresh press; keyboard activation has detail 0.
        if (event.detail !== 0 && pressed.current !== event.currentTarget) return;
        pressed.current = null;
        item.select();
      }}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={item.icon} />
      </svg>
      {item.label}
    </button>)}
  </div>;
}
