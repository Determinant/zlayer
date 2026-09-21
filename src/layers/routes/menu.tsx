import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useBackDismiss } from '../../core/ui/pwa-back';
import type { RouteDraft, RoutePlan } from '@zlayer/domain';
import { foreFlightRouteUrl, routeExportText, ROUTE_EXPORT_FORMATS, type RouteExportFormat } from './export';
import { RouteStashDialog, type RouteStashView } from './stash-dialog';

type ExportAction = 'copy' | 'share';

export function RouteMenu({ plan, onOpen, onClear, onLoadRoute, navlogOpen, navlogId, onToggleNavlog }: {
  plan: RoutePlan; onOpen: () => void; onClear: () => void; onLoadRoute: (draft: RouteDraft) => void;
  navlogOpen: boolean; navlogId: string; onToggleNavlog: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [manualCopy, setManualCopy] = useState<string>();
  const [exportAction, setExportAction] = useState<ExportAction>();
  const [stash, setStash] = useState<RouteStashView>();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  const shareButtonRef = useRef<HTMLButtonElement>(null);
  const formatMenuRef = useRef<HTMLDivElement>(null);
  const exportRequestRef = useRef(0);
  const sharingRef = useRef<number | undefined>(undefined);
  const id = useId();
  const text = routeExportText(plan);
  const isAppleMobile = typeof navigator !== 'undefined' &&
    (/iPad|iPhone|iPod/.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);

  useEffect(() => {
    setMessage('');
    setManualCopy(undefined);
    setExportAction(undefined);
  }, [text, open]);

  // Ignore results from an older route, action, or opening of the menu.
  useEffect(() => () => { exportRequestRef.current++; }, [text, open, exportAction]);

  useEffect(() => {
    if (exportAction) formatMenuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [exportAction]);

  useEffect(() => {
    if (manualCopy) {
      textRef.current?.focus();
      textRef.current?.select();
    }
  }, [manualCopy]);

  const close = () => { setOpen(false); buttonRef.current?.focus(); };
  const show = () => { onOpen(); setOpen(true); };
  const showFormats = (action: ExportAction) => {
    if (exportAction === action) formatMenuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    setManualCopy(undefined); setMessage(''); setExportAction(action);
  };
  const closeFormats = () => {
    (exportAction === 'share' ? shareButtonRef : copyButtonRef).current?.focus();
    setExportAction(undefined); setManualCopy(undefined); setMessage('');
  };
  useBackDismiss(open, rootRef, () => exportAction ? closeFormats() : close());
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (exportAction) closeFormats();
      else close();
      return;
    }
    if (event.target === textRef.current) return;
    if (open && event.key === 'ArrowRight' && text) {
      const action = document.activeElement === copyButtonRef.current ? 'copy'
        : document.activeElement === shareButtonRef.current ? 'share' : undefined;
      if (action) { event.preventDefault(); showFormats(action); return; }
    }
    if (exportAction && event.key === 'ArrowLeft') {
      event.preventDefault(); closeFormats(); return;
    }
    if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      show();
      return;
    }
    if (!open || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const menu = (event.target as HTMLElement).closest('[role="menu"]') ?? menuRef.current!;
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')]
      .filter(item => item.closest('[role="menu"]') === menu);
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  const copy = async (format: RouteExportFormat) => {
    const request = ++exportRequestRef.current;
    const copiedText = routeExportText(plan, format);
    setManualCopy(undefined);
    setMessage('');
    try {
      await navigator.clipboard.writeText(copiedText);
      if (request !== exportRequestRef.current) return;
      setMessage('Route copied');
    } catch {
      if (request !== exportRequestRef.current) return;
      setMessage('Select and copy the route below.');
      setManualCopy(copiedText);
    }
  };
  const share = async (format: RouteExportFormat, source: HTMLButtonElement) => {
    if (sharingRef.current !== undefined) return;
    const request = ++exportRequestRef.current;
    sharingRef.current = request;
    setMessage('');
    try {
      // Web Share hides the destination app; choose its format before opening the sheet.
      await navigator.share({ text: routeExportText(plan, format) });
      if (request === exportRequestRef.current) close();
    } catch (error) {
      if (request !== exportRequestRef.current) return;
      if (rootRef.current?.contains(source)) source.focus();
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setMessage('Sharing is unavailable. Use Copy Route.');
      }
    } finally {
      sharingRef.current = undefined;
    }
  };
  const formats = (action: ExportAction) => exportAction === action && <div id={`${id}-${action}-formats`}
    role="menu" aria-label={`${action === 'copy' ? 'Copy' : 'Share'} route format`}
    className="route-export-formats" ref={formatMenuRef}>
    {ROUTE_EXPORT_FORMATS.map(format => <button key={format.id} type="button" role="menuitem"
      onClick={event => {
        // Safari taps can leave focus on the page; keep keyboard actions in the menu.
        event.currentTarget.focus();
        void (action === 'copy' ? copy(format.id) : share(format.id, event.currentTarget));
      }}>
      <strong>{format.label}</strong><small>{format.description}</small>
    </button>)}
  </div>;

  return <div className="route-menu" ref={rootRef} onKeyDown={onKeyDown}
    onBlur={event => {
      // Safari can blur to null before a tapped button's click, as can a native
      // share sheet. Outside pointerdowns and focus moving elsewhere dismiss us.
      if (event.relatedTarget !== null && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
    }}>
    <button type="button" className="route-heading" ref={buttonRef} aria-label="Route actions"
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => open ? close() : show()}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="5" cy="17" r="2" /><circle cx="19" cy="7" r="2" />
        <path d="M7 16c4-1 6-7 10-8" />
      </svg>
      <span>Route</span>
      <svg className="route-menu-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4 3 3 3-3" /></svg>
    </button>
    {open && <div className={`route-menu-popover${exportAction ? ' has-export-formats' : ''}`}>
      <div id={id} role="menu" aria-label="Route actions" ref={menuRef}>
        <button type="button" role="menuitem" aria-expanded={navlogOpen} aria-controls={navlogOpen ? navlogId : undefined}
          onClick={() => { close(); onToggleNavlog(); }}>{navlogOpen ? 'Hide' : 'Show'} NavLog</button>
        <div role="separator" />
        <button type="button" role="menuitem" ref={copyButtonRef} disabled={!text}
          aria-haspopup="menu" aria-expanded={exportAction === 'copy'}
          aria-controls={exportAction === 'copy' ? `${id}-copy-formats` : undefined}
          onClick={() => exportAction === 'copy' ? closeFormats() : showFormats('copy')}>
          Copy Route<span className="route-export-chevron" aria-hidden="true">{exportAction === 'copy' ? '▾' : '▸'}</span>
        </button>
        {formats('copy')}
        {isAppleMobile && <button type="button" role="menuitem" disabled={!text}
          onClick={() => { window.location.href = foreFlightRouteUrl(plan); close(); }}>Open in ForeFlight</button>}
        {canShare && <button type="button" role="menuitem" ref={shareButtonRef} disabled={!text}
          aria-haspopup="menu" aria-expanded={exportAction === 'share'}
          aria-controls={exportAction === 'share' ? `${id}-share-formats` : undefined}
          onClick={() => exportAction === 'share' ? closeFormats() : showFormats('share')}>
          Share…<span className="route-export-chevron" aria-hidden="true">{exportAction === 'share' ? '▾' : '▸'}</span>
        </button>}
        {formats('share')}
        <div role="separator" />
        <button type="button" role="menuitem" disabled={!plan.entries.length} onClick={() => {
          setOpen(false); setStash({ mode: 'save', draft: structuredClone({ entries: plan.entries }) });
        }}>Save Route</button>
        <button type="button" role="menuitem" onClick={() => { setOpen(false); setStash({ mode: 'list' }); }}>Manage Routes</button>
        <div role="separator" />
        <button type="button" role="menuitem" className="route-menu-clear" disabled={!text}
          onClick={() => { setOpen(false); onClear(); }}>Clear Route</button>
      </div>
      <div role="status">{message}</div>
      {manualCopy !== undefined && <textarea ref={textRef} aria-label="Route text to copy" value={manualCopy} readOnly rows={3} />}
    </div>}
    {stash && <RouteStashDialog initial={stash} onLoad={onLoadRoute} onClose={() => {
      setStash(undefined);
      requestAnimationFrame(() => buttonRef.current?.focus());
    }} />}
  </div>;
}
