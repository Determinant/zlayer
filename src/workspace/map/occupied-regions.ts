import type { ScreenRect } from '../../core/map/contribution';

/** Shell integration lives here; map tools only receive rectangles in map pixels. */
export function occupiedMapRegions(container: HTMLElement): ScreenRect[] {
  const rect = container.getBoundingClientRect();
  return [...(container.closest('.map-stage') ?? container.parentElement ?? container)
    .querySelectorAll<HTMLElement>('[data-map-occupied], .ruler-card, .ruler-toggle, .layer-control-button, .map-navigation-control, .map-edge-handle, .edge-panel-body')]
    .filter(element => !element.closest('[inert]') && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden')
    .map(element => {
      const box = element.getBoundingClientRect();
      return { left: box.left - rect.left, right: box.right - rect.left,
        top: box.top - rect.top, bottom: box.bottom - rect.top };
    });
}
