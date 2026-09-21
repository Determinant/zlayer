import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useBackDismiss } from '../../core/ui/pwa-back';
import type { RoutePreviewInset } from './map-preview';
import './preview-panel.css';

/** Preview panels leave the map interactive and reserve its unobscured area for fitting. */
export function usePreviewPanel(open: boolean, panel: RefObject<HTMLDivElement | null>,
  closeButton: RefObject<HTMLButtonElement | null>, onDismiss: (restoreFocus: boolean) => void,
  trigger?: RefObject<HTMLButtonElement | null>) {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const [inset, setInset] = useState<RoutePreviewInset>({ right: 0, bottom: 0 });
  useBackDismiss(open, panel, () => dismiss.current(true));
  useLayoutEffect(() => {
    if (!open) return;
    closeButton.current?.focus();
    const measure = () => {
      const element = panel.current;
      if (!element) return;
      const bounds = element.getBoundingClientRect();
      const map = element.closest('.app-shell')?.querySelector('.map-canvas')?.getBoundingClientRect();
      const next = getComputedStyle(element).position === 'fixed'
        ? { right: 0, bottom: Math.max(0, Math.ceil((map?.bottom ?? innerHeight) - bounds.top)) + 8 }
        : { right: Math.max(0, Math.ceil((map?.right ?? innerWidth) - bounds.left)) + 8, bottom: 0 };
      setInset(current => current.right === next.right && current.bottom === next.bottom ? current : next);
    };
    const observer = new ResizeObserver(measure);
    if (panel.current) observer.observe(panel.current);
    const map = panel.current?.closest('.app-shell')?.querySelector('.map-canvas');
    if (map) observer.observe(map);
    measure();
    window.addEventListener('resize', measure);
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('.map-canvas')) return;
      if (!panel.current?.contains(event.target as Node) && !trigger?.current?.contains(event.target as Node)) dismiss.current(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); dismiss.current(true); }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, panel, closeButton, trigger]);
  return inset;
}
