import { pluginStorage } from './storage';
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { EdgePanelFrame, useEdgePanel, usePanelReturnFocus } from '../../core/ui/edge-panels';
import { PanelSurface, FullScreenButton } from '../../core/ui/panel-surface';
import { LoadingPlaceholder } from '../../core/ui/loading-placeholder';
import { formatDate, formatDateRange } from '../../core/format/time';
import type { ProcedureDocument, ProcedureSelection } from './data';
import { usePluginState } from '../../core/ui/use-persistent-state';
import { isBoolean } from '../../core/storage/ui-state';
import { plateViewKey, plateSelectionRecord } from './persistence';
import { useBackDismiss } from '../../core/ui/pwa-back';
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
  const [fullScreen, setFullScreen] = usePluginState(pluginStorage, `${plateViewKey(selection)}:fullscreen`, false, isBoolean);
  const restoreFocus = usePanelReturnFocus();
  const closeButton = useRef<HTMLButtonElement>(null);
  const fullScreenButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const source = selection.document;
  const dismiss = () => {
    const finish = () => {
      plateSelectionRecord.write(null);
      onClose();
      restoreFocus();
    };
    if (fullScreen) { setOpen(false); finish(); }
    else close(finish);
  };

  return <EdgePanelFrame panel={panel} label={`${selection.airport.id} plate`}
    className={`procedure-panel${fullScreen ? ' is-fullscreen' : ''}`}
    icon={<><path d="M6 3h9l4 4v14H6Z" /><path d="M14 3v5h5M10 12h5m-5 4h5" /></>}>
    <PanelSurface {...panel.bodyProps} visible={open} expanded={fullScreen} onExitFullScreen={() => setFullScreen(false)}
      fullScreenButton={fullScreenButton} initialFocus={closeButton}
      className="procedure-window edge-panel-body" aria-labelledby={titleId}>
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
            <FullScreenButton className="ui-button ui-button--icon" expanded={fullScreen} button={fullScreenButton} onClick={() => setFullScreen(value => !value)} />
            <button className="ui-button ui-button--icon" ref={closeButton} type="button" onClick={dismiss} aria-label="Close plate">×</button>
          </div>
        </header>
        <HeaderActionContext.Provider value={headerAction}>{children}</HeaderActionContext.Provider>
      </article>
    </PanelSurface>
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

export function ProcedureFooter({ source, pageIndex, pageCount, zoom, cacheState, onPageChange, onZoomChange, onRotate, onReset, mapAction }: {
  source: ProcedureDocument; pageIndex: number; pageCount: number; zoom: number; cacheState: PlateCacheState;
  onPageChange?: (page: number) => void; onZoomChange?: (zoom: number) => void; onRotate?: () => void; onReset?: () => void;
  mapAction?: ReactNode;
}) {
  const [pagesOpen, setPagesOpen] = useState(false);
  const pages = useRef<HTMLDivElement>(null);
  const pageButton = useRef<HTMLButtonElement>(null);
  const pageContent = useRef<HTMLDivElement>(null);
  const pagesId = useId();
  const closePages = () => { setPagesOpen(false); pageButton.current?.focus(); };
  useBackDismiss(pagesOpen, pages, closePages);
  useEffect(() => {
    if (!pagesOpen) return;
    const content = pageContent.current;
    const firstControl = [...(content?.querySelectorAll<HTMLElement>('button:not(:disabled), a') ?? [])]
      .find(element => element.getClientRects().length > 0);
    (firstControl ?? content)?.focus();
    const observer = new ResizeObserver(() => {
      if (!pageButton.current?.offsetWidth) setPagesOpen(false);
    });
    if (pageButton.current) observer.observe(pageButton.current);
    const dismiss = (event: PointerEvent) => {
      if (!pages.current?.contains(event.target as Node)) setPagesOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => { observer.disconnect(); document.removeEventListener('pointerdown', dismiss); };
  }, [pagesOpen]);
  const changePage = (next: number) => {
    onPageChange?.(next);
    if (pagesOpen) closePages();
  };
  return <footer>
    <div className="procedure-reading-controls">
      <div className={`procedure-page-controls${pagesOpen ? ' is-open' : ''}`} ref={pages}
        onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPagesOpen(false); }}
        onKeyDown={event => {
          if (event.key === 'Escape' && pagesOpen) {
            event.preventDefault(); event.stopPropagation(); closePages();
          }
        }}>
        <button type="button" className="ui-button procedure-page-picker" ref={pageButton}
          aria-label={`Choose PDF page, page ${pageIndex + 1} of ${pageCount}`} title={`Page ${pageIndex + 1} / ${pageCount}`}
          aria-expanded={pagesOpen} aria-controls={pagesId} onClick={() => pagesOpen ? closePages() : setPagesOpen(true)}>
          <small>Page ▾</small><span>{pageIndex + 1}</span>
        </button>
        <div className="procedure-page-picker-content" id={pagesId} ref={pageContent} tabIndex={-1}>
          <div className="procedure-pagination">
            <button className="ui-button ui-button--icon" type="button" disabled={!onPageChange || pageIndex === 0}
              onClick={() => changePage(pageIndex - 1)} aria-label="Previous PDF page">‹</button>
            <span>Page {pageIndex + 1} / {pageCount}</span>
            <button className="ui-button ui-button--icon" type="button" disabled={!onPageChange || pageIndex >= pageCount - 1}
              onClick={() => changePage(pageIndex + 1)} aria-label="Next PDF page">›</button>
          </div>
          <a className="ui-button ui-button--compact procedure-original" href={source.nativeUrl} target="_blank" rel="noreferrer">Open original ↗</a>
        </div>
      </div>
      <div className="procedure-zoom-controls">
        <button className="ui-button ui-button--icon" type="button" disabled={!onZoomChange || zoom <= 0.5}
          onClick={() => onZoomChange?.(zoom / 1.2)} aria-label="Zoom out">−</button>
        <button className="ui-button procedure-reset-view" type="button" disabled={!onReset}
          onClick={onReset} aria-label="Reset plate view" title="Reset view: fit width, original orientation, top of page">
          <span>{Math.round(zoom * 100)}%</span><small>Reset</small>
        </button>
        <button className="ui-button ui-button--icon" type="button" disabled={!onZoomChange || zoom >= 4}
          onClick={() => onZoomChange?.(zoom * 1.2)} aria-label="Zoom in">+</button>
        <button className="ui-button ui-button--icon" type="button" disabled={!onRotate}
          onClick={onRotate} aria-label="Rotate 90° clockwise" title="Rotate 90° clockwise">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 4v6h-6M20 10a8 8 0 1 0-2 8" />
          </svg>
        </button>
      </div>
    </div>
    {mapAction}
    <span className={`procedure-cache-state is-${cacheState}`}>
      {cacheState === 'cached' ? 'Available offline' : cacheState === 'saving'
        ? `Saving offline${source.byteLength ? ` · ${Math.round(source.byteLength / 1024 / 1024)} MB` : ''}`
        : 'Not saved offline'}
    </span>
  </footer>;
}
