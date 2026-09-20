import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { LoadingPlaceholder } from '../../core/ui/loading-placeholder';
import { formatDate, formatDateRange } from '../../core/format/time';
import type { ProcedureDocument, ProcedureSelection } from './data';
import { usePersistentState } from '../../core/ui/use-persistent-state';
import { isBoolean, writeUiState } from '../../core/storage/ui-state';
import { plateViewKey } from './persistence';
import type { ProcedureDownloadProgress } from './document-cache';

export type PlateCacheState = 'saving' | 'cached' | 'unavailable';

/** Keep the modal, focus and controls mounted while the PDF renderer loads. */
export function ProcedureDialog({ selection, onClose, children }: {
  selection: ProcedureSelection; onClose: () => void; children: ReactNode;
}) {
  const [closing, setClosing] = useState(false);
  const [fullScreen, setFullScreen] = usePersistentState(`${plateViewKey(selection)}:fullscreen`, false, isBoolean);
  const dismiss = () => { writeUiState('plate-selection', null); setClosing(true); };
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const source = selection.document;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  useEffect(() => {
    if (!closing) return;
    const timeout = window.setTimeout(onClose, 300);
    return () => window.clearTimeout(timeout);
  }, [closing, onClose]);

  return <dialog ref={dialogRef} className={`procedure-viewer-backdrop${closing ? ' is-closing' : ''}`}
    aria-labelledby={titleId} onCancel={event => {
      event.preventDefault();
      if (fullScreen) setFullScreen(false);
      else dismiss();
    }}>
    <article className={`procedure-viewer${fullScreen ? ' is-fullscreen' : ''}`}
      onAnimationEnd={event => { if (closing && event.target === event.currentTarget) onClose(); }}>
      <header>
        <div className="procedure-heading">
          <span className="eyebrow">{selection.airport.id} · FAA {selection.cycle.includes('-') ? formatDate(selection.cycle) : selection.cycle}</span>
          <h2 id={titleId}>{fullScreen && `${selection.airport.id} · `}{selection.procedure.name}</h2>
          <p>Effective {formatDateRange(selection.effectiveDate, selection.expirationDate)}
            {' · '}{source.source === 'chart-supplement' ? 'Chart Supplement' :
              source.source === 'combined-volume' ? 'Combined TPP' : 'FAA document'}</p>
        </div>
        <div className="procedure-viewer-actions">
          <button type="button" onClick={() => setFullScreen(value => !value)}
            aria-label={fullScreen ? 'Exit full screen' : 'Enter full screen'}
            title={fullScreen ? 'Exit full screen' : 'Enter full screen'} aria-pressed={fullScreen}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={fullScreen
                ? 'M3 9h6V3m6 0v6h6M3 15h6v6m6 0v-6h6'
                : 'M9 3H3v6m12-6h6v6M3 15v6h6m6 0h6v-6'} />
            </svg>
          </button>
          <button type="button" autoFocus onClick={dismiss} aria-label="Close plate">×</button>
        </div>
      </header>
      {children}
    </article>
  </dialog>;
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

export function ProcedureFooter({ source, pageIndex, pageCount, zoom, cacheState, onPageChange, onZoomChange }: {
  source: ProcedureDocument; pageIndex: number; pageCount: number; zoom: number; cacheState: PlateCacheState;
  onPageChange?: (page: number) => void; onZoomChange?: (zoom: number) => void;
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
    <span className={`procedure-cache-state is-${cacheState}`}>
      {cacheState === 'cached' ? 'Available offline' : cacheState === 'saving'
        ? `Saving offline${source.byteLength ? ` · ${Math.round(source.byteLength / 1024 / 1024)} MB` : ''}`
        : 'Not saved offline'}
    </span>
    <a href={source.nativeUrl} target="_blank" rel="noreferrer">Open original ↗</a>
  </footer>;
}
