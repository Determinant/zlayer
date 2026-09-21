import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';

type PointerSession = {
  revision: number;
  pointerId: number;
  pointerType: string;
  sourceId: string | undefined;
  targetId: string | undefined;
  startX: number;
  startY: number;
  clientX: number;
  clientY: number;
  sourceCenter: number;
  startScrollLeft: number;
  maxScrollLeft: number;
  mode: 'pending' | 'scrolling' | 'dragging';
  moved: boolean;
  longPressTimer?: number;
  animationFrame?: number;
  element: HTMLElement;
};

export type DragVisual = {
  sourceId: string;
  targetId: string;
  offsetX: number;
  before: boolean;
};

type TokenMenu = {
  revision: number;
  entryId: string;
  ident: string;
  left: number;
};

const DRAG_THRESHOLD_PX = 6;
const LONG_PRESS_MS = 450;
const MENU_WIDTH_PX = 176;
const AUTO_SCROLL_EDGE_PX = 34;
const AUTO_SCROLL_SPEED_PX = 600;

export function useEditorGestures(revision: number, onMoveEntry: (from: string, to: string) => void) {
  const [drag, setDrag] = useState<DragVisual>();
  const [scrolling, setScrolling] = useState(false);
  const [menu, setMenu] = useState<TokenMenu>();
  const formRef = useRef<HTMLFormElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const pointerSessionRef = useRef<PointerSession | undefined>(undefined);
  const suppressClickRef = useRef(false);

  const cancelPointer = () => {
    const session = pointerSessionRef.current;
    if (!session) return;
    pointerSessionRef.current = undefined;
    suppressClickRef.current = true;
    releasePointer(session);
    setDrag(undefined);
    setScrolling(false);
  };

  useEffect(() => {
    const editor = editorRef.current;
    // Keep native scrolling and momentum until a hold has activated the drag.
    // A non-passive touch listener is necessary: changing touch-action after
    // pointerdown cannot change ownership of an in-progress gesture on iOS.
    const touchMove = (event: TouchEvent) => {
      const session = pointerSessionRef.current;
      if (!session || session.pointerType !== 'touch') return;
      if (event.touches.length !== 1) { cancelPointer(); return; }
      if (session.mode === 'dragging') {
        if (event.cancelable) event.preventDefault();
        else cancelPointer();
      }
    };
    editor?.addEventListener('touchmove', touchMove, { passive: false });
    return () => editor?.removeEventListener('touchmove', touchMove);
  }, []);

  useEffect(() => {
    if (!menu) return;
    menuButtonRef.current?.focus();
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!formRef.current?.contains(event.target as Node)) setMenu(undefined);
    };
    const closeOnKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenu(undefined);
        inputRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnKeyDown);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnKeyDown);
    };
  }, [menu]);

  useEffect(() => {
    setDrag(undefined);
    setScrolling(false);
    setMenu(undefined);
    const secondPointer = (event: PointerEvent) => {
      const session = pointerSessionRef.current;
      if (session && session.pointerId !== event.pointerId) cancelPointer();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && pointerSessionRef.current) {
        event.preventDefault();
        cancelPointer();
      }
    };
    document.addEventListener('pointerdown', secondPointer);
    document.addEventListener('keydown', escape);
    window.addEventListener('blur', cancelPointer);
    return () => {
      document.removeEventListener('pointerdown', secondPointer);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('blur', cancelPointer);
      const session = pointerSessionRef.current;
      pointerSessionRef.current = undefined;
      if (session) {
        suppressClickRef.current = true;
        releasePointer(session);
      }
    };
  }, [revision]);

  const openMenu = (
    entryId: string,
    ident: string,
    element: HTMLButtonElement,
  ) => {
    // Touch contextmenu events can arrive while the finger is still holding.
    if (pointerSessionRef.current?.pointerType === 'touch') return;
    const formBounds = formRef.current?.getBoundingClientRect();
    const tokenBounds = element.getBoundingClientRect();
    const naturalLeft = formBounds ? tokenBounds.left - formBounds.left : 0;
    const maximumLeft = Math.max(0, (formBounds?.width ?? MENU_WIDTH_PX) - MENU_WIDTH_PX);
    setMenu({
      revision,
      entryId,
      ident,
      left: Math.min(maximumLeft, Math.max(0, naturalLeft)),
    });
  };

  const clickToken = (event: ReactMouseEvent<HTMLButtonElement>, entryId: string, ident: string) => {
    event.stopPropagation();
    if (event.detail !== 0 && suppressClickRef.current) { event.preventDefault(); return; }
    openMenu(entryId, ident, event.currentTarget);
  };

  const captureClick = (event: ReactMouseEvent<HTMLElement>) => {
    // A released pan can click the strip itself instead of the starting chip.
    // Suppress it before it reaches either the input-focus or button handlers.
    if (event.detail !== 0 && suppressClickRef.current) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const updateDrag = (session: PointerSession) => {
    if (session.sourceId === undefined) return;
    const editor = editorRef.current;
    const target = nearestEntry(editor, session);
    const targetId = target?.entryId ?? session.sourceId;
    session.targetId = targetId;
    setDrag({
      sourceId: session.sourceId,
      targetId,
      offsetX: session.clientX - session.startX + (editor?.scrollLeft ?? 0) - session.startScrollLeft,
      before: target?.before ?? false,
    });
  };

  const startDrag = (session: PointerSession) => {
    session.mode = 'dragging';
    suppressClickRef.current = true;
    clearLongPressTimer(session);
    session.element.setPointerCapture(session.pointerId);
    setMenu(undefined);
    updateDrag(session);
    let lastFrame: number | undefined;
    const tick = (time: number) => {
      if (pointerSessionRef.current !== session) return;
      const elapsed = lastFrame === undefined ? 0 : Math.min(32, time - lastFrame);
      lastFrame = time;
      const editor = editorRef.current;
      const previousScroll = editor?.scrollLeft;
      if (session.moved) autoScrollEditor(editor, session, elapsed);
      if (editor?.scrollLeft !== previousScroll) updateDrag(session);
      session.animationFrame = window.requestAnimationFrame(tick);
    };
    session.animationFrame = window.requestAnimationFrame(tick);
  };

  const beginPointer = (
    event: ReactPointerEvent<HTMLElement>,
    entryId?: string,
  ) => {
    if (event.button !== 0 || event.isPrimary === false || pointerSessionRef.current) return;
    suppressClickRef.current = false;
    // Chips start their own session before bubbling here. Gaps can pan with a
    // mouse, while fields and approach controls keep their native interaction.
    if (entryId === undefined && (event.pointerType === 'touch' ||
      (event.target as Element).closest('input, textarea, select, button, a, [contenteditable]'))) return;
    const element = event.currentTarget;
    const bounds = (element.closest<HTMLElement>('[data-route-entry]') ?? element).getBoundingClientRect();
    setMenu(undefined);
    if (event.pointerType !== 'touch') {
      event.preventDefault();
      element.setPointerCapture(event.pointerId);
    }
    const session: PointerSession = {
      revision,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      sourceId: entryId,
      targetId: entryId,
      startX: event.clientX,
      startY: event.clientY,
      clientX: event.clientX,
      clientY: event.clientY,
      sourceCenter: bounds.left + bounds.width / 2,
      startScrollLeft: editorRef.current?.scrollLeft ?? 0,
      maxScrollLeft: Math.max(0, (editorRef.current?.scrollWidth ?? 0) - (editorRef.current?.clientWidth ?? 0)),
      mode: 'pending',
      moved: false,
      element,
    };
    if (entryId !== undefined) {
      session.longPressTimer = window.setTimeout(() => {
        if (pointerSessionRef.current !== session || session.mode !== 'pending') return;
        if (editorRef.current?.scrollLeft !== session.startScrollLeft) {
          session.mode = 'scrolling';
          suppressClickRef.current = true;
          return;
        }
        startDrag(session);
      }, LONG_PRESS_MS);
    }
    pointerSessionRef.current = session;
  };

  const movePointer = (event: ReactPointerEvent<HTMLElement>) => {
    const session = pointerSessionRef.current;
    if (!session || session.revision !== revision || session.pointerId !== event.pointerId) return;
    session.clientX = event.clientX;
    session.clientY = event.clientY;
    const distance = Math.hypot(
      event.clientX - session.startX,
      event.clientY - session.startY,
    );
    if (distance >= DRAG_THRESHOLD_PX) session.moved = true;
    if (session.mode === 'pending') {
      if (!session.moved) return;
      clearLongPressTimer(session);
      session.mode = 'scrolling';
      suppressClickRef.current = true;
    }
    if (session.mode === 'scrolling') {
      if (session.pointerType === 'touch') return;
      event.preventDefault();
      setScrolling(true);
      const editor = editorRef.current;
      if (editor) editor.scrollLeft = Math.max(0, Math.min(session.maxScrollLeft,
        session.startScrollLeft + session.startX - session.clientX));
      return;
    }
    event.preventDefault();
    updateDrag(session);
  };

  const finishPointer = (
    event: ReactPointerEvent<HTMLElement>,
    cancelled: boolean,
  ) => {
    const session = pointerSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    pointerSessionRef.current = undefined;
    releasePointer(session);
    if (cancelled) suppressClickRef.current = true;
    if (!cancelled && session.revision === revision && session.mode === 'dragging' &&
      session.sourceId !== undefined && session.targetId !== undefined && session.sourceId !== session.targetId) {
      onMoveEntry(session.sourceId, session.targetId);
    }
    setDrag(undefined);
    setScrolling(false);
  };

  return { drag, scrolling, menu: menu?.revision === revision ? menu : undefined, setMenu, formRef, editorRef, inputRef, menuButtonRef,
    openMenu, clickToken, captureClick, beginPointer, movePointer, finishPointer };
}

function releasePointer(session: PointerSession): void {
  clearLongPressTimer(session);
  if (session.animationFrame !== undefined) window.cancelAnimationFrame(session.animationFrame);
  if (session.element.hasPointerCapture(session.pointerId)) session.element.releasePointerCapture(session.pointerId);
}

function clearLongPressTimer(session: PointerSession): void {
  if (session.longPressTimer === undefined) return;
  window.clearTimeout(session.longPressTimer);
  delete session.longPressTimer;
}

function nearestEntry(editor: HTMLElement | null, session: PointerSession): { entryId: string; before: boolean } | undefined {
  const elements = editor?.querySelectorAll<HTMLElement>('[data-route-entry]');
  if (!elements || elements.length === 0) return undefined;
  const ordered = [...elements];
  const sourceIndex = ordered.findIndex(element => element.dataset.routeEntry === session.sourceId);
  return ordered.reduce<{ entryId: string; distance: number; before: boolean }>((nearest, element, index) => {
    // Compare against the source's original slot, not its translated preview.
    // Use the pointed-to entry's bounds so a wide approach bundle doesn't
    // offset the drop destination away from the waypoint under the pointer.
    const left = index === sourceIndex
      ? session.sourceCenter - element.offsetWidth / 2 - (editor!.scrollLeft - session.startScrollLeft)
      : element.getBoundingClientRect().left;
    const distance = Math.max(left - session.clientX, session.clientX - left - element.offsetWidth, 0);
    return distance < nearest.distance
      ? { entryId: element.dataset.routeEntry!, distance, before: index < sourceIndex }
      : nearest;
  }, { entryId: '', distance: Number.POSITIVE_INFINITY, before: false });
}

function autoScrollEditor(editor: HTMLElement | null, session: PointerSession, elapsed: number): void {
  if (!editor) return;
  const { clientX, clientY } = session;
  const bounds = editor.getBoundingClientRect();
  if (clientY < bounds.top || clientY > bounds.bottom) return;
  let direction = 0;
  if (clientX < bounds.left + AUTO_SCROLL_EDGE_PX) {
    direction = -Math.min(1, (bounds.left + AUTO_SCROLL_EDGE_PX - clientX) / AUTO_SCROLL_EDGE_PX);
  } else if (clientX > bounds.right - AUTO_SCROLL_EDGE_PX) {
    direction = Math.min(1, (clientX - bounds.right + AUTO_SCROLL_EDGE_PX) / AUTO_SCROLL_EDGE_PX);
  }
  // A translated chip can enlarge scrollWidth; stop at the original content end.
  editor.scrollLeft = Math.max(0, Math.min(session.maxScrollLeft,
    editor.scrollLeft + direction * AUTO_SCROLL_SPEED_PX * elapsed / 1000));
}
