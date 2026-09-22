import type { Map as MapLibreMap } from 'maplibre-gl';
import type { MapLayerModule } from '../../core/map/layer';
import { LayerScope } from '../../core/layers/scope';
import type { RulerEndpoint, RulerLayer, RulerSnapshot } from './layer';
import { createRulerRenderer, RULER_LAYER_IDS } from './renderer';
import { suggestedEnd, type ScreenPoint, type ScreenRect } from './handles';
import type { Coordinate } from './measurement';

/** Pointer events on the canvas only observe taps; native map pan/pinch remain in charge. */
export function createRulerMapLayer(product: RulerLayer, occupiedRects: () => ScreenRect[] = () => []): MapLayerModule<void> {
  let scope: LayerScope | undefined;
  return {
    id: 'ruler', slot: 'route', overlayLayerIds: RULER_LAYER_IDS,
    update() {},
    mount(map) {
      scope = new LayerScope();
      try { attach(map, product, occupiedRects, scope); }
      catch (error) { scope.dispose(); throw error; }
    },
    unmount() { scope?.dispose(); scope = undefined; },
  };
}

function attach(map: MapLibreMap, product: RulerLayer, occupiedRects: () => ScreenRect[], scope: LayerScope) {
  const view = createRulerRenderer(map, scope), canvas = map.getCanvas(), container = map.getContainer();
  type DomEvents = HTMLElementEventMap & WindowEventMap & DocumentEventMap;
  function listen<K extends keyof DomEvents>(target: EventTarget, type: K, handler: (event: DomEvents[K]) => void, options?: AddEventListenerOptions) {
    const listener = handler as EventListener;
    target.addEventListener(type, listener, options);
    scope.add(() => target.removeEventListener(type, listener, options));
  }
  const point = (event: PointerEvent): ScreenPoint => {
    const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * canvas.clientWidth / rect.width,
      y: (event.clientY - rect.top) * canvas.clientHeight / rect.height };
  };
  const coordinate = (point: ScreenPoint): Coordinate => {
    const position = map.unproject([point.x, point.y]);
    return [position.lng, position.lat];
  };
  let tap: { id: number; origin: ScreenPoint; touch: boolean; moved: boolean; session: number } | undefined;
  let drag: { id: number; endpoint: RulerEndpoint; origin: ScreenPoint; anchor: ScreenPoint;
    offset: ScreenPoint; before: RulerSnapshot; button: HTMLButtonElement; moved: boolean } | undefined;
  const pointers = new Set<number>();
  let doubleClickWasEnabled: boolean | undefined;
  let obstacles: ScreenRect[] = [];
  const findObstacles = () => { obstacles = occupiedRects(); };
  const draw = () => view.draw(product.getSnapshot(), obstacles, drag);
  const endDrag = (commit: boolean) => {
    const current = drag;
    if (!current) return;
    drag = undefined;
    current.button.classList.remove('is-dragging');
    if (current.button.hasPointerCapture(current.id)) current.button.releasePointerCapture(current.id);
    if (!commit || !current.moved) product.restore(current.before);
    else {
      const position = product.getSnapshot()[current.endpoint];
      if (position) product.move(current.endpoint, position, true);
    }
    findObstacles();
    draw();
  };
  const cancel = () => { tap = undefined; endDrag(false); };
  const stateChanged = () => {
    const state = product.getSnapshot();
    if (drag && drag.before.session !== state.session) endDrag(false);
    if (tap && tap.session !== state.session) tap = undefined;
    if (state.active && doubleClickWasEnabled === undefined) {
      doubleClickWasEnabled = map.doubleClickZoom.isEnabled();
      map.doubleClickZoom.disable();
      findObstacles();
    } else if (!state.active && doubleClickWasEnabled !== undefined) {
      if (doubleClickWasEnabled) map.doubleClickZoom.enable();
      doubleClickWasEnabled = undefined;
      cancel();
    }
    canvas.classList.toggle('ruler-active', state.active);
    draw();
  };
  scope.add(() => canvas.classList.remove('ruler-active'));
  scope.add(() => { if (doubleClickWasEnabled) map.doubleClickZoom.enable(); });
  scope.add(cancel);
  scope.add(product.subscribe(stateChanged));
  // Observe all fingers, including one added outside the canvas or on a control.
  listen(window, 'pointerdown', (event: PointerEvent) => {
    pointers.add(event.pointerId);
    if (pointers.size > 1) cancel();
  }, { capture: true });
  listen(canvas, 'pointerdown', (event: PointerEvent) => {
    const state = product.getSnapshot();
    if (!state.active || state.end || event.button !== 0 || !event.isPrimary || pointers.size !== 1) return;
    findObstacles();
    tap = { id: event.pointerId, origin: point(event), touch: event.pointerType === 'touch', moved: false, session: state.session };
  });
  listen(window, 'pointermove', (event: PointerEvent) => {
    if (tap?.id !== event.pointerId && drag?.id !== event.pointerId) return;
    const next = point(event);
    if (tap?.id === event.pointerId && Math.hypot(next.x - tap.origin.x, next.y - tap.origin.y) > 6) tap.moved = true;
    if (!drag || drag.id !== event.pointerId) return;
    event.preventDefault();
    const dx = next.x - drag.origin.x, dy = next.y - drag.origin.y;
    if (Math.hypot(dx, dy) > 2) drag.moved = true;
    if (!drag.moved) return;
    // An offset endpoint is constrained to the visible map without changing its grip offset.
    product.move(drag.endpoint, coordinate({ x: Math.max(1, Math.min(container.clientWidth - 1, drag.anchor.x + dx)),
      y: Math.max(1, Math.min(container.clientHeight - 1, drag.anchor.y + dy)) }));
  }, { passive: false });
  listen(window, 'pointerup', (event: PointerEvent) => {
    if (drag?.id === event.pointerId) {
      const next = point(event);
      const inside = next.x >= 0 && next.y >= 0 && next.x <= container.clientWidth && next.y <= container.clientHeight;
      if (inside) {
        const dx = next.x - drag.origin.x, dy = next.y - drag.origin.y;
        if (Math.hypot(dx, dy) > 2) {
          drag.moved = true;
          product.move(drag.endpoint, coordinate({ x: Math.max(1, Math.min(container.clientWidth - 1, drag.anchor.x + dx)),
            y: Math.max(1, Math.min(container.clientHeight - 1, drag.anchor.y + dy)) }));
        }
      }
      endDrag(inside);
    } else if (tap?.id === event.pointerId) {
      const current = tap, next = point(event);
      tap = undefined;
      if (!current.moved && pointers.size === 1 && event.target === canvas &&
        Math.hypot(next.x - current.origin.x, next.y - current.origin.y) <= 6 && !map.isMoving()) {
        product.place(coordinate(next), current.touch && !product.getSnapshot().start
          ? coordinate(suggestedEnd(next, container.clientWidth, container.clientHeight, obstacles)) : undefined);
      }
    }
    pointers.delete(event.pointerId);
  }, { capture: true });
  listen(window, 'pointercancel', (event: PointerEvent) => {
    if (drag?.id === event.pointerId || tap?.id === event.pointerId) cancel();
    pointers.delete(event.pointerId);
  }, { capture: true });
  for (const handle of view.handles) {
    listen(handle.button, 'pointerdown', (event: PointerEvent) => {
      if (event.button !== 0 || !event.isPrimary || pointers.size !== 1) return;
      event.preventDefault(); event.stopPropagation();
      map.stop();
      findObstacles();
      drag = { id: event.pointerId, endpoint: handle.endpoint, origin: point(event),
        anchor: { ...handle.anchor }, offset: { x: handle.grip.x - handle.anchor.x, y: handle.grip.y - handle.anchor.y },
        before: product.getSnapshot(), button: handle.button, moved: false };
      handle.button.setPointerCapture(event.pointerId);
      handle.button.focus({ preventScroll: true });
      handle.button.classList.add('is-dragging');
    });
    listen(handle.button, 'lostpointercapture', () => endDrag(false));
    // MapLibre listens to mouse/touch compatibility events as well as pointer events.
    for (const type of ['mousedown', 'touchstart', 'dblclick', 'contextmenu'] as const) {
      listen(handle.button, type, (event: Event) => { event.preventDefault(); event.stopPropagation(); }, { passive: false });
    }
    listen(handle.button, 'keydown', (event: KeyboardEvent) => {
      const directions: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const direction = directions[event.key];
      if (!direction || drag) return;
      event.preventDefault(); event.stopPropagation();
      const step = event.shiftKey ? 10 : 1;
      product.move(handle.endpoint, coordinate({ x: handle.anchor.x + direction[0] * step,
        y: handle.anchor.y + direction[1] * step }), true);
    });
  }
  listen(window, 'keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape' && drag) { event.preventDefault(); event.stopImmediatePropagation(); cancel(); }
  }, { capture: true });
  listen(window, 'blur', () => { pointers.clear(); cancel(); });
  listen(document, 'visibilitychange', () => { if (document.hidden) { pointers.clear(); cancel(); } });
  const moving = () => { if (tap) tap.moved = true; };
  const resize = () => { cancel(); findObstacles(); draw(); };
  map.on('movestart', moving); scope.add(() => map.off('movestart', moving));
  map.on('move', draw); scope.add(() => map.off('move', draw));
  map.on('resize', resize); scope.add(() => map.off('resize', resize));
  const layout = new ResizeObserver(() => { findObstacles(); draw(); });
  scope.add(() => layout.disconnect());
  layout.observe(container);
  stateChanged();
}
