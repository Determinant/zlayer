import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

type PointerSession = {
  revision: number;
  pointerId: number;
  pointerType: string;
  sourceId: string;
  targetId: string;
  startX: number;
  startY: number;
  startScrollLeft: number;
  dragging: boolean;
  longPressed: boolean;
  longPressTimer?: number;
  element: HTMLButtonElement;
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
const LONG_PRESS_MS = 520;
const MENU_WIDTH_PX = 176;
const AUTO_SCROLL_EDGE_PX = 34;
const AUTO_SCROLL_STEP_PX = 12;

export function useEditorGestures(revision: number, onMoveEntry: (from: string, to: string) => void) {
  const [drag, setDrag] = useState<DragVisual>();
  const [menu, setMenu] = useState<TokenMenu>();
  const formRef = useRef<HTMLFormElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const pointerSessionRef = useRef<PointerSession | undefined>(undefined);

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
    setMenu(undefined);
    return () => {
      const session = pointerSessionRef.current;
      pointerSessionRef.current = undefined;
      if (session) releasePointer(session);
    };
  }, [revision]);

  const openMenu = (
    entryId: string,
    ident: string,
    element: HTMLButtonElement,
  ) => {
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

  const beginPointer = (
    event: ReactPointerEvent<HTMLButtonElement>,
    entryId: string,
    ident: string,
  ) => {
    if (event.button !== 0 || pointerSessionRef.current) return;
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    const session: PointerSession = {
      revision,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      sourceId: entryId,
      targetId: entryId,
      startX: event.clientX,
      startY: event.clientY,
      startScrollLeft: editorRef.current?.scrollLeft ?? 0,
      dragging: false,
      longPressed: false,
      element,
    };
    if (event.pointerType !== 'mouse') {
      session.longPressTimer = window.setTimeout(() => {
        if (pointerSessionRef.current !== session || session.dragging) return;
        session.longPressed = true;
        openMenu(entryId, ident, element);
      }, LONG_PRESS_MS);
    }
    pointerSessionRef.current = session;
  };

  const movePointer = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const session = pointerSessionRef.current;
    if (!session || session.revision !== revision || session.pointerId !== event.pointerId || session.longPressed) return;
    const distance = Math.hypot(
      event.clientX - session.startX,
      event.clientY - session.startY,
    );
    if (!session.dragging && distance < DRAG_THRESHOLD_PX) return;
    if (!session.dragging) {
      session.dragging = true;
      clearLongPressTimer(session);
      setMenu(undefined);
    }
    event.preventDefault();
    autoScrollEditor(editorRef.current, event.clientX);
    const target = nearestEntry(editorRef.current, event.clientX, session.sourceId);
    session.targetId = target?.entryId ?? session.targetId;
    const scrollDelta = (editorRef.current?.scrollLeft ?? 0) - session.startScrollLeft;
    setDrag({
      sourceId: session.sourceId,
      targetId: session.targetId,
      offsetX: event.clientX - session.startX + scrollDelta,
      before: target?.before ?? false,
    });
  };

  const finishPointer = (
    event: ReactPointerEvent<HTMLButtonElement>,
    cancelled: boolean,
  ) => {
    const session = pointerSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    pointerSessionRef.current = undefined;
    releasePointer(session);
    if (!cancelled && session.revision === revision && session.dragging && session.sourceId !== session.targetId) {
      onMoveEntry(session.sourceId, session.targetId);
    }
    setDrag(undefined);
  };

  return { drag, menu: menu?.revision === revision ? menu : undefined, setMenu, formRef, editorRef, inputRef, menuButtonRef, openMenu, beginPointer, movePointer, finishPointer };
}

function releasePointer(session: PointerSession): void {
  clearLongPressTimer(session);
  if (session.element.hasPointerCapture(session.pointerId)) session.element.releasePointerCapture(session.pointerId);
}

function clearLongPressTimer(session: PointerSession): void {
  if (session.longPressTimer === undefined) return;
  window.clearTimeout(session.longPressTimer);
  delete session.longPressTimer;
}

function nearestEntry(editor: HTMLElement | null, clientX: number, sourceId: string): { entryId: string; before: boolean } | undefined {
  const elements = editor?.querySelectorAll<HTMLElement>('[data-route-entry]');
  if (!elements || elements.length === 0) return undefined;
  const ordered = [...elements];
  const sourceIndex = ordered.findIndex(element => element.dataset.routeEntry === sourceId);
  return ordered.reduce<{ entryId: string; distance: number; before: boolean }>((nearest, element, index) => {
    const center = element.getBoundingClientRect().left + element.offsetWidth / 2;
    const distance = Math.abs(center - clientX);
    return distance < nearest.distance
      ? { entryId: element.dataset.routeEntry!, distance, before: index < sourceIndex }
      : nearest;
  }, { entryId: '', distance: Number.POSITIVE_INFINITY, before: false });
}

function autoScrollEditor(editor: HTMLElement | null, clientX: number): void {
  if (!editor) return;
  const bounds = editor.getBoundingClientRect();
  if (clientX < bounds.left + AUTO_SCROLL_EDGE_PX) {
    editor.scrollLeft -= AUTO_SCROLL_STEP_PX;
  } else if (clientX > bounds.right - AUTO_SCROLL_EDGE_PX) {
    editor.scrollLeft += AUTO_SCROLL_STEP_PX;
  }
}
