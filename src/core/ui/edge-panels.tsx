import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState,
  type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { EdgeHandle } from './edge-handle';
import { useBackDismiss } from './pwa-back';

export type PanelSide = 'left' | 'right';
/** Slots count away from an edge; removing a panel never compacts other slots. */
export type PanelTab = { edge: 'top' | 'bottom'; order: number };
export type PanelPlacement = { side: PanelSide; tab: PanelTab; bodyFromEdge?: boolean };
/** Return false to defer; call proceed after an optional feature-owned confirmation. */
export type PanelStowGuard = (next: string | null, proceed: () => boolean) => boolean;
type MountedPanel = { element: HTMLDivElement; beforeStow: PanelStowGuard };

export const PanelDefaults = createContext<(PanelPlacement & { name: string; label: string }) | null>(null);

const PanelsContext = createContext<{
  side: PanelSide; active: string | null;
  host: HTMLDivElement | null; presented: string | null; open: boolean; individualTabs: boolean;
  request: (next: string | null, onCommit?: () => void) => boolean;
  register: (name: string, panel: MountedPanel) => () => void;
} | null>(null);

export function usePanelSide() { return useContext(PanelsContext)?.side; }

/** Deferred switches restore focus after the incoming tab is committed. */
export function focusPanelTab(name: string): void {
  requestAnimationFrame(() => {
    const tabs = document.querySelectorAll<HTMLElement>('[data-edge-tab]');
    for (const tab of tabs) if (tab.dataset.edgeTab === name) {
      tab.querySelector<HTMLButtonElement>('.map-edge-handle')?.focus();
      break;
    }
  });
}

/** Restore a closing panel's opener, or its tab when the opener was stowed/removed. */
export function usePanelReturnFocus() {
  const [opener] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const [panelId] = useState(() => opener?.closest('.edge-panel-body')?.id);
  return useCallback(() => {
    requestAnimationFrame(() => {
      if (opener?.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true });
      else if (panelId) document.querySelector<HTMLButtonElement>(`[aria-controls="${CSS.escape(panelId)}"]`)
        ?.focus({ preventScroll: true });
    });
  }, [opener, panelId]);
}

/** One visible panel per edge; each tab slides with its own panel. */
export function EdgePanels({ side, active, onActiveChange, className = '', individualTabs = false, children }: {
  side: PanelSide; active: string | null; onActiveChange: (next: string | null) => void;
  className?: string; individualTabs?: boolean; children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const mounted = useRef(new Map<string, MountedPanel>());
  const requestId = useRef(0);
  const [revision, setRevision] = useState(0);
  const current = useRef({ active, onActiveChange });
  // Controlled changes are requests too, even if the selection later returns
  // to the same panel while a feature's confirmation is still open.
  if (current.current.active !== active) ++requestId.current;
  current.current = { active, onActiveChange };
  const register = useCallback((name: string, panel: MountedPanel) => {
    if (mounted.current.has(name)) throw new Error(`Duplicate edge panel: ${name}`);
    mounted.current.set(name, panel);
    setRevision(value => value + 1);
    return () => { mounted.current.delete(name); setRevision(value => value + 1); };
  }, []);
  const request = useCallback((next: string | null, onCommit?: () => void) => {
    const { active } = current.current;
    const token = ++requestId.current;
    if (next === active) { onCommit?.(); return true; }
    const source = active ? mounted.current.get(active) : undefined;
    const proceed = () => {
      if (token !== requestId.current || current.current.active !== active ||
        (source && mounted.current.get(active!) !== source)) return false;
      ++requestId.current; // Confirmations can commit only once.
      current.current.onActiveChange(next);
      onCommit?.();
      return true;
    };
    return source?.beforeStow(next, proceed) === false ? false : proceed();
  }, []);
  // Keep the outgoing panel until it reaches the edge. Only then may the next
  // panel enter. Changing the request during a slide either reverses that slide
  // or changes its destination; it never introduces a second visible panel.
  const [presented, setPresented] = useState(active);
  const [available, setAvailable] = useState(false);
  const open = presented !== null && presented === active && available;

  useLayoutEffect(() => {
    const element = root.current!;
    const panel = presented === null ? undefined : mounted.current.get(presented)?.element;
    // Restored selections may load after the surrounding workspace. Start
    // their entrance when the panel actually mounts, not while it is absent.
    setAvailable(!!panel);
    const measure = () => {
      const area = element.getBoundingClientRect();
      const bounds = panel?.getBoundingClientRect();
      if (individualTabs) for (const { element: frame } of mounted.current.values()) {
        const width = frame.getBoundingClientRect().width - frame.querySelector('.map-edge-handle')!.getBoundingClientRect().width;
        frame.style.setProperty('--edge-own-offset', `${width}px`);
      }
      if (bounds) {
        const offset = individualTabs ? bounds.width - panel!.querySelector('.map-edge-handle')!.getBoundingClientRect().width
          : side === 'right' ? area.right - bounds.left : bounds.right - area.left;
        element.style.setProperty('--edge-panel-offset', `${offset}px`);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const { element: frame } of mounted.current.values()) observer.observe(frame);
    let cancelled = false;
    if (active !== presented) {
      // Reading animations flushes the closing style. An empty list also
      // handles reduced motion and opening from an already stowed state.
      const slides = element.getAnimations().filter(animation =>
        animation instanceof CSSTransition && animation.transitionProperty === '--edge-panel-reveal');
      void Promise.allSettled(slides.map(animation => animation.finished)).then(() => {
        if (!cancelled) setPresented(active);
      });
    }
    return () => { cancelled = true; observer.disconnect(); };
  }, [active, presented, revision, side, individualTabs]);

  return <div ref={root} className={`edge-panels is-${side}${individualTabs ? ' has-individual-tabs' : ''} ${className}`}
    data-active={active ?? undefined} data-revealed={open || undefined}>
    <PanelsContext value={{ side, active, host, presented, open, individualTabs, request, register }}>
      {children}
      {!individualTabs && <div ref={setHost} className="edge-panel-tabs" />}
    </PanelsContext>
  </div>;
}

/** Shared selection, dismissal and focus lifecycle for either edge. */
export function useEdgePanel(name: string, options: {
  beforeStow?: PanelStowGuard | undefined;
  initialOpen?: boolean; side?: PanelSide;
} = {}) {
  const panels = useContext(PanelsContext);
  const defaults = useContext(PanelDefaults);
  const root = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLButtonElement>(null);
  const id = useId();
  const [standaloneOpen, setStandaloneOpen] = useState(options.initialOpen ?? true);
  const selected = panels ? panels.active === name : standaloneOpen;
  const presented = panels ? panels.presented === name : standaloneOpen;
  const open = panels ? presented && panels.open : standaloneOpen;
  const latest = useRef({ panels, options });
  const standaloneRequest = useRef(0);
  latest.current = { panels, options };
  const register = panels?.register;
  // Register the actual frame, not the hook's first render: a feature may keep
  // the hook alive while data or a lazy renderer delays its DOM.
  const ref = useCallback((element: HTMLDivElement | null) => {
    root.current = element;
    if (!element) return;
    const unregister = register?.(name, {
      element, beforeStow: (next, proceed) => latest.current.options.beforeStow?.(next, proceed) ?? true,
    });
    return () => { root.current = null; unregister?.(); };
  }, [name, register]);
  const [onStowed, setOnStowed] = useState<(() => void) | null>(null);
  useEffect(() => {
    if (!onStowed) return;
    if (selected) { setOnStowed(null); return; }
    if (!presented) { setOnStowed(null); onStowed(); return; }
    const finish = () => { setOnStowed(null); onStowed(); };
    window.addEventListener('pagehide', finish, { once: true });
    return () => window.removeEventListener('pagehide', finish);
  }, [onStowed, presented, selected]);
  const setOpen = useCallback((next: boolean, onCommit?: () => void) => {
    const { panels, options } = latest.current;
    const commit = () => { if (next) setOnStowed(null); onCommit?.(); };
    if (panels) {
      if (!next && panels.active !== name) { commit(); return true; }
      return panels.request(next ? name : null, commit);
    }
    const token = ++standaloneRequest.current;
    const proceed = () => {
      if (token !== standaloneRequest.current || !root.current?.isConnected) return false;
      ++standaloneRequest.current;
      setStandaloneOpen(next); commit(); return true;
    };
    return !next && options.beforeStow?.(null, proceed) === false ? false : proceed();
  }, [name]);
  const stow = () => setOpen(false, () => {
    // Let a field's Escape handler discard its draft before blur commits it.
    requestAnimationFrame(() => handle.current?.focus({ preventScroll: true }));
  });
  return { name, id, ref, root, handle, selected, presented, open, setOpen, stow,
    side: panels?.side ?? defaults?.side ?? options.side ?? 'right',
    close: (onClose: () => void) => { setOpen(false, () => setOnStowed(() => onClose)); },
    bodyProps: { id, inert: !open, 'aria-hidden': !open },
  };
}

function EdgePanelTab({ name, tab, children }: { name: string; tab: PanelTab; children: ReactNode }) {
  const tabs = useContext(PanelsContext);
  if (!tabs) return children;
  if (tabs.individualTabs) return <div data-edge-tab={name} style={{ display: 'contents' }}>{children}</div>;
  return tabs.host && createPortal(<div data-edge-tab={name}
    className={tabs.presented === name ? 'is-presented' : undefined}
    style={{ [tab.edge]: `${tab.order * 48}px` }}>{children}</div>, tabs.host);
}

type PanelController = ReturnType<typeof useEdgePanel>;

/** Custom bodies (including native dialogs) share the same tab and Escape behavior. */
export function EdgePanelFrame({ panel, label, icon, tab, className = '', style, children }: {
  panel: PanelController; label: string; icon: ReactNode; tab?: PanelTab;
  className?: string; style?: CSSProperties | undefined; children: ReactNode;
}) {
  const defaults = useContext(PanelDefaults);
  useBackDismiss(panel.selected, panel.root, panel.stow, 0);
  return <div ref={panel.ref} style={style}
    className={`edge-panel ${className}${panel.open ? ' is-open' : ''}${panel.presented ? ' is-presented' : ''}`}
    onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onKeyDown={event => {
      if (event.key !== 'Escape' || !panel.open ||
        (event.target as HTMLElement).closest('dialog:modal')) return;
      event.stopPropagation();
      // A guard may have just opened a confirmation dialog; this Escape must
      // neither cancel it nor continue into map shortcuts.
      event.preventDefault();
      panel.stow();
    }}>
    <EdgePanelTab name={panel.name} tab={defaults?.tab ?? tab ?? { edge: 'top', order: 0 }}>
      <EdgeHandle ref={panel.handle} controls={panel.id} open={panel.selected} label={label} side={panel.side}
        onClick={() => panel.selected ? panel.stow() : panel.setOpen(true, () => {
          // WebKit does not focus pointer-activated buttons by default. Keep
          // the requested body in front on touch as well as keyboard activation.
          panel.handle.current?.focus({ preventScroll: true });
        })}>{icon}</EdgeHandle>
    </EdgePanelTab>
    {children}
  </div>;
}

/** A layer can render this inside its registered Panel contribution on either edge. */
export function EdgePanel({ name, label, icon, tab, autoOpen = true, beforeStow, className = '', children }: {
  name?: string; label?: string; icon: ReactNode; tab?: PanelTab; autoOpen?: boolean;
  beforeStow?: PanelStowGuard; className?: string;
  children: ReactNode | ((panel: PanelController) => ReactNode);
}) {
  const defaults = useContext(PanelDefaults);
  const panelName = name ?? defaults?.name;
  if (!panelName) throw new Error('An edge panel needs a registered layer or a name');
  const panel = useEdgePanel(panelName, { beforeStow });
  const position = defaults?.tab ?? tab ?? { edge: 'top', order: 0 };
  const group = useContext(PanelsContext);
  useLayoutEffect(() => { if (autoOpen) panel.setOpen(true); }, [autoOpen, panel.setOpen]);
  return <EdgePanelFrame panel={panel} label={label ?? defaults?.label ?? panelName} icon={icon} tab={position}
    className={`edge-panel-window ${className}`}
    style={group?.individualTabs ? { [position.edge]: position.order * 48,
      ...(position.edge === 'bottom' ? { top: 'auto', alignItems: 'flex-end' } : {}) } : undefined}>
    <div {...panel.bodyProps} tabIndex={-1} className="edge-panel-content edge-panel-body">
      {typeof children === 'function' ? children(panel) : children}
    </div>
  </EdgePanelFrame>;
}
