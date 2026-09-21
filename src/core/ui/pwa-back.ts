import { useLayoutEffect, useRef, type RefObject } from 'react';

const HISTORY_KEY = '__zlayerPwaBack';
const BASE = 'base-v1';
const GUARD = 'guard-v1';
type BackTarget = { element: HTMLElement; dismiss(): void; priority: number; order: number };
const targets = new Set<BackTarget>();
let order = 0;

/** Register visible UI only. Panels use priority 0; their menus use priority 1. */
export function useBackDismiss(open: boolean, ref: RefObject<HTMLElement | null>, dismiss: () => void, priority = 1) {
  const latest = useRef(dismiss);
  latest.current = dismiss;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!open || !element) return;
    const target = { element, dismiss: () => latest.current(), priority, order: ++order };
    targets.add(target);
    return () => { targets.delete(target); };
  }, [open, ref, priority]);
}

function activeTarget(modal?: HTMLDialogElement) {
  const candidates = [...targets].filter(({ element }) => element.isConnected && !element.closest('[inert]') &&
    (!modal || modal.contains(element)));
  candidates.sort((a, b) => a.priority - b.priority ||
    (a.element.contains(b.element) ? -1 : b.element.contains(a.element) ? 1 : a.order - b.order));
  return candidates.at(-1);
}

function dismissActive() {
  // Focus is constrained to the topmost modal, including portalled dialogs.
  const modal = document.activeElement?.closest<HTMLDialogElement>('dialog:modal')
    ?? [...document.querySelectorAll<HTMLDialogElement>('dialog:modal')].at(-1);
  const target = activeTarget(modal);
  if (target) { target.dismiss(); return; }
  if (!modal) return;
  // Follow native cancellation, including confirmation guards and full-screen
  // exit. Older iOS releases do not implement requestClose().
  if (typeof modal.requestClose === 'function') modal.requestClose();
  else if (modal.dispatchEvent(new Event('cancel', { cancelable: true }))) modal.close();
}

/** Installed apps reserve one same-document Back step. Browser tabs stay native. */
export function observePwaBack() {
  const standalone = matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (!standalone) return () => {};

  const arm = () => {
    if (history.state?.[HISTORY_KEY] === GUARD) return;
    if (history.state?.[HISTORY_KEY] !== BASE) {
      history.replaceState({ ...history.state, [HISTORY_KEY]: BASE }, '');
    }
    history.pushState({ ...history.state, [HISTORY_KEY]: GUARD }, '');
  };
  const activate = (event: Event) => {
    if (!(event.target instanceof Node)) return;
    const next = ++order;
    for (const target of targets) if (target.element.contains(event.target)) target.order = next;
  };
  let returning = false;
  const back = (event: PopStateEvent) => {
    if (event.state?.[HISTORY_KEY] === GUARD) { returning = false; return; }
    if (event.state?.[HISTORY_KEY] !== BASE || returning) return;
    returning = true;
    // Reuse the gesture-created entry, including after reload. Pushing a new
    // entry here could make the next iOS swipe skip it after user activation expires.
    history.forward();
    dismissActive();
  };
  const onInteraction = (event: Event) => {
    // WebKit/Chromium may skip entries created without a real user gesture.
    // The first tap also protects a bare map with no dismissible UI.
    if (event.isTrusted && !returning) arm();
  };
  const cancel = (event: Event) => {
    // Android may deliver Back directly to a native dialog without traversing
    // history. Dismiss a menu inside it before the dialog's own cancel handler.
    if (!event.cancelable || !(event.target instanceof HTMLDialogElement) || !event.target.matches(':modal')) return;
    const target = activeTarget(event.target);
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    target.dismiss();
  };
  window.addEventListener('popstate', back);
  window.addEventListener('click', onInteraction, true);
  window.addEventListener('pointerup', onInteraction, true);
  window.addEventListener('keydown', onInteraction, true);
  document.addEventListener('pointerdown', activate, true);
  document.addEventListener('focusin', activate, true);
  document.addEventListener('cancel', cancel, true);
  return () => {
    window.removeEventListener('popstate', back);
    window.removeEventListener('click', onInteraction, true);
    window.removeEventListener('pointerup', onInteraction, true);
    window.removeEventListener('keydown', onInteraction, true);
    document.removeEventListener('pointerdown', activate, true);
    document.removeEventListener('focusin', activate, true);
    document.removeEventListener('cancel', cancel, true);
  };
}
