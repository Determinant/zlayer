import type { ScreenRect } from '../../core/map/contribution';
import { createFrameTask } from '../../core/graphics/frame-task';

const OCCUPIED = '[data-map-occupied], .ruler-card, .ruler-toggle, .layer-control-button, .map-navigation-control, .map-edge-handle, .edge-panel-body';
const LAYOUT = `${OCCUPIED}, .edge-panels, .edge-panel, .ruler-tool`;

/** Shell integration lives here; map tools only receive rectangles in map pixels. */
export function occupiedMapRegions(container: HTMLElement): ScreenRect[] {
  const rect = container.getBoundingClientRect();
  return [...(container.closest('.map-stage') ?? container.parentElement ?? container)
    .querySelectorAll<HTMLElement>(OCCUPIED)]
    .filter(element => !element.closest('[inert]') && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden')
    .map(element => {
      const box = element.getBoundingClientRect();
      return { left: box.left - rect.left, right: box.right - rect.left,
        top: box.top - rect.top, bottom: box.bottom - rect.top };
    });
}

/** Observe shell layout only while a tool needs it; grip/canvas writes are ignored. */
export function observeOccupiedMapRegions(container: HTMLElement, changed: () => void): () => void {
  const root = container.closest('.map-stage') ?? container.parentElement ?? container;
  const observed = new Set<Element>();
  const frame = createFrameTask(() => { reconcile(); changed(); });
  const resize = new ResizeObserver(() => frame.schedule());
  const reconcile = () => {
    const current = new Set<Element>([container, ...root.querySelectorAll(OCCUPIED)]);
    for (const element of observed) if (!current.has(element)) { resize.unobserve(element); observed.delete(element); }
    for (const element of current) if (!observed.has(element)) { resize.observe(element); observed.add(element); }
  };
  const relevant = (node: Node) => node instanceof Element &&
    (node.matches(LAYOUT) || [...observed].some(element => node.contains(element)));
  const mutations = new MutationObserver(records => {
    if (records.some(record => record.type === 'attributes' ? relevant(record.target)
      : [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element &&
        (node.matches(LAYOUT) || node.querySelector(LAYOUT))))) frame.schedule();
  });
  const transition = (event: Event) => { if (event.target instanceof Node && relevant(event.target)) frame.schedule(); };
  const dispose = () => {
    mutations.disconnect(); resize.disconnect(); frame.cancel(); observed.clear();
    root.removeEventListener('transitionend', transition);
    root.removeEventListener('transitioncancel', transition);
  };
  try {
    reconcile();
    mutations.observe(root, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'inert', 'data-map-occupied', 'data-revealed', 'open'] });
    root.addEventListener('transitionend', transition);
    root.addEventListener('transitioncancel', transition);
    return dispose;
  } catch (error) { dispose(); throw error; }
}
