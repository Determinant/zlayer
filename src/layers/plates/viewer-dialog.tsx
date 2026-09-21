import { createContext, useContext, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { EdgePanelFrame, useEdgePanel } from '../../core/ui/edge-panels';
import { LoadingPlaceholder } from '../../core/ui/loading-placeholder';
import { formatDate, formatDateRange } from '../../core/format/time';
import type { ProcedureDocument, ProcedureSelection } from './data';
import { usePersistentState } from '../../core/ui/use-persistent-state';
import { isBoolean, writeUiState } from '../../core/storage/ui-state';
import { plateViewKey } from './persistence';
import type { ProcedureDownloadProgress } from './document-cache';

export type PlateCacheState = 'saving' | 'cached' | 'unavailable';

const HeaderActionContext = createContext<HTMLElement | null>(null);

/** Keep action state in the lazy reader while placing its button in the header. */
export function ProcedureHeaderAction({ children }: { children: ReactNode }) {
  const target = useContext(HeaderActionContext);
  return target ? createPortal(children, target) : null;
}

/** Keep one reader mounted through loading, stowing, and full-screen changes. */
export function ProcedureDialog({ selection, onClose, children }: {
  selection: ProcedureSelection; onClose: () => void; children: ReactNode;
}) {
  const panel = useEdgePanel('plate');
  const { open, setOpen, close } = panel;
  const [headerAction, setHeaderAction] = useState<HTMLSpanElement | null>(null);
  const [fullScreen, setFullScreen] = usePersistentState(`${plateViewKey(selection)}:fullscreen`, false, isBoolean);
  // The opener may disappear if the airport panel is closed independently.
  const [opener] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const [openerPanelId] = useState(() => opener?.closest('.edge-panel-body')?.id);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const fullScreenButton = useRef<HTMLButtonElement>(null);
  const wasFullScreen = useRef(false);
  const initiallyFocused = useRef(false);
  const titleId = useId();
  const source = selection.document;
  const dismiss = () => {
    const finish = () => {
      writeUiState('plate-selection', null);
      onClose();
      requestAnimationFrame(() => {
        if (opener?.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true });
        else if (openerPanelId) document.querySelector<HTMLButtonElement>(`[aria-controls="${CSS.escape(openerPanelId)}"]`)
          ?.focus({ preventScroll: true });
      });
    };
    if (fullScreen) { setOpen(false); finish(); }
    else close(finish);
  };

  useLayoutEffect(() => {
    const dialog = dialogRef.current!;
    return () => dialog.close();
  }, []);

  useLayoutEffect(() => {
    const dialog = dialogRef.current!;
    if (!open) { if (dialog.matches(':modal')) dialog.close(); return; }
    if (fullScreen) {
      dialog.close();
      dialog.showModal();
      fullScreenButton.current?.focus({ preventScroll: true });
    } else {
      if (wasFullScreen.current) dialog.close();
      if (!dialog.open) dialog.setAttribute('open', '');
      if (wasFullScreen.current) fullScreenButton.current?.focus({ preventScroll: true });
      else if (!initiallyFocused.current) closeButton.current?.focus({ preventScroll: true });
    }
    initiallyFocused.current = true;
    wasFullScreen.current = fullScreen;
  }, [fullScreen, open]);

  return <EdgePanelFrame panel={panel} label={`${selection.airport.id} plate`}
    className={`procedure-panel${fullScreen ? ' is-fullscreen' : ''}`}
    icon={<><path d="M6 3h9l4 4v14H6Z" /><path d="M14 3v5h5M10 12h5m-5 4h5" /></>}>
    <dialog ref={dialogRef} {...panel.bodyProps} open className="procedure-window edge-panel-body"
      aria-modal={fullScreen || undefined} aria-labelledby={titleId}
      onCancel={event => { event.preventDefault(); event.stopPropagation(); if (fullScreen) setFullScreen(false); }}>
      <article className={`procedure-viewer${fullScreen ? ' is-fullscreen' : ''}`}>
        <header>
          <div className="procedure-heading">
            <span className="eyebrow">{selection.airport.id} · FAA {selection.cycle.includes('-') ? formatDate(selection.cycle) : selection.cycle}</span>
            <h2 id={titleId}>{fullScreen && `${selection.airport.id} · `}{selection.procedure.name}</h2>
            <p>Effective {formatDateRange(selection.effectiveDate, selection.expirationDate)}
              {' · '}{source.source === 'chart-supplement' ? 'Chart Supplement' :
                source.source === 'combined-volume' ? 'Combined TPP' : 'FAA document'}</p>
          </div>
          <div className="procedure-viewer-actions">
            <span ref={setHeaderAction}
              className={`procedure-header-action${selection.procedure.kind === 'approach' ? ' is-reserved' : ''}`} />
            <button ref={fullScreenButton} type="button" onClick={() => setFullScreen(value => !value)}
              aria-label={fullScreen ? 'Exit full screen' : 'Enter full screen'}
              title={fullScreen ? 'Exit full screen' : 'Enter full screen'} aria-pressed={fullScreen}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d={fullScreen
                  ? 'M3 9h6V3m6 0v6h6M3 15h6v6m6 0v-6h6'
                  : 'M9 3H3v6m12-6h6v6M3 15v6h6m6 0h6v-6'} />
              </svg>
            </button>
            <button ref={closeButton} type="button" onClick={dismiss} aria-label="Close plate">×</button>
          </div>
        </header>
        <HeaderActionContext.Provider value={headerAction}>{children}</HeaderActionContext.Provider>
      </article>
    </dialog>
  </EdgePanelFrame>;
}

export function ProcedurePageLoading({ source, progress }: {
  source?: ProcedureDocument; progress?: ProcedureDownloadProgress | undefined;
}) {
  const titleId = useId(), descriptionId = useId();
  if (!progress) return <div className="procedure-page-loading"><LoadingPlaceholder label="Preparing plate…" /></div>;
  const supplement = source?.source === 'chart-supplement';
  const bundled = source?.source === 'combined-volume' || supplement;
  const preparing = progress.phase === 'preparing';
  const percent = preparing ? 100 : progress.total
    ? Math.min(99, Math.floor(progress.loaded / progress.total * 100)) : undefined;
  const size = `${formatDownloadBytes(progress.loaded)}${progress.total ? ` of ${formatDownloadBytes(progress.total)}` : ''}`;
  const title = preparing ? 'Download complete. Preparing page…' : supplement
    ? 'Downloading Chart Supplement…' : bundled ? 'Downloading regional plates…' : 'Downloading plate…';
  return <div className="procedure-page-loading">
    <div className="procedure-download">
      <div role="status" aria-atomic="true">
        <h3 id={titleId}>{title}</h3>
        {bundled && <p id={descriptionId}>The first download may take a moment. Once saved, other{' '}
          {supplement ? 'airport entries' : 'plates'} in this regional book open much faster.</p>}
      </div>
      <div className="procedure-download-meter" role="progressbar" aria-labelledby={titleId}
        aria-describedby={bundled ? descriptionId : undefined} aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={percent} aria-valuetext={percent === undefined ? `${size} downloaded` : `${percent}% · ${size}`}>
        <span className={percent === undefined ? 'is-indeterminate' : undefined}
          style={percent === undefined ? undefined : { width: `${percent}%` }} />
      </div>
      <div className="procedure-download-amount" aria-hidden="true">
        <span>{size}</span><strong>{percent === undefined ? 'Downloading…' : `${percent}%`}</strong>
      </div>
    </div>
  </div>;
}

function formatDownloadBytes(bytes: number): string {
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(bytes / 1024 / 1024)} MB`;
}

export function ProcedureLoading({ source }: { source: ProcedureDocument }) {
  return <>
    <div className="procedure-page-stage" aria-busy="true"><ProcedurePageLoading /></div>
    <ProcedureFooter source={source} pageIndex={source.pageIndex} pageCount={source.pageCount ?? 1}
      zoom={1} cacheState="saving" />
  </>;
}

export function ProcedureFooter({ source, pageIndex, pageCount, zoom, cacheState, onPageChange, onZoomChange, mapAction }: {
  source: ProcedureDocument; pageIndex: number; pageCount: number; zoom: number; cacheState: PlateCacheState;
  onPageChange?: (page: number) => void; onZoomChange?: (zoom: number) => void;
  mapAction?: ReactNode;
}) {
  return <footer>
    <div className="procedure-page-controls">
      <button type="button" disabled={!onPageChange || pageIndex === 0}
        onClick={() => onPageChange?.(pageIndex - 1)} aria-label="Previous PDF page">‹</button>
      <span>Page {pageIndex + 1} / {pageCount}</span>
      <button type="button" disabled={!onPageChange || pageIndex >= pageCount - 1}
        onClick={() => onPageChange?.(pageIndex + 1)} aria-label="Next PDF page">›</button>
    </div>
    <div className="procedure-zoom-controls">
      <button type="button" disabled={!onZoomChange || zoom <= 0.5}
        onClick={() => onZoomChange?.(zoom / 1.2)} aria-label="Zoom out">−</button>
      <span>{Math.round(zoom * 100)}%</span>
      <button type="button" disabled={!onZoomChange || zoom >= 4}
        onClick={() => onZoomChange?.(zoom * 1.2)} aria-label="Zoom in">+</button>
    </div>
    {mapAction}
    <span className={`procedure-cache-state is-${cacheState}`}>
      {cacheState === 'cached' ? 'Available offline' : cacheState === 'saving'
        ? `Saving offline${source.byteLength ? ` · ${Math.round(source.byteLength / 1024 / 1024)} MB` : ''}`
        : 'Not saved offline'}
    </span>
    <a href={source.nativeUrl} target="_blank" rel="noreferrer">Open original ↗</a>
  </footer>;
}
