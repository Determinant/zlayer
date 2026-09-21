import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  getDocument,
  GlobalWorkerOptions,
  VerbosityLevel,
  type PDFDocumentProxy,
  type PDFDocumentLoadingTask,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
// Use the matching compatibility worker as well: Safari needs PDF.js's polyfills.
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

import type { ProcedureSelection } from './data';
import { ProcedureFooter, ProcedureHeaderAction, ProcedurePageLoading, type PlateCacheState } from './viewer-dialog';
import { pdfCanvasSize } from './render-scale';
import { clampPlateZoom, usePinchZoom } from './use-pinch-zoom';
import { loadProcedureDocument, type ProcedureDownloadProgress } from './document-cache';
import { BlobRangeTransport } from './blob-range';
import { procedurePageIndex } from './page-target';
import { retainActiveFiles } from '../../offline/active-catalogs';
import { readUiState, writeUiState } from '../../core/storage/ui-state';
import { usePersistentState } from '../../core/ui/use-persistent-state';
import { plateViewKey } from './persistence';
import { isRecord } from '@zlayer/contracts';
import type { PlateMapImage } from './map-image';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type ProcedureViewerProps = {
  selection: ProcedureSelection;
  onShowOnMap?: (image: PlateMapImage) => void;
};

type ViewerState = {
  document?: PDFDocumentProxy;
  error?: string;
};

export default function ProcedureViewer({ selection, onShowOnMap }: ProcedureViewerProps) {
  const key = plateViewKey(selection);
  const [savedPage, setPageIndex] = usePersistentState<number | null>(`${key}:page`, null,
    (value): value is number | null => value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0));
  const pageIndex = savedPage ?? selection.document.pageIndex;
  const zoomKey = `${key}:zoom`, scrollKey = `${key}:scroll`;
  const [zoom, setZoom] = useState(() => readUiState(zoomKey, 1,
    (value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0.5 && value <= 4));
  const [savedScroll] = useState(() => readUiState(scrollKey, { left: 0, top: 0 },
    (value): value is { left: number; top: number } => isRecord(value) &&
      [value.left, value.top].every(item => typeof item === 'number' && Number.isFinite(item) && item >= 0)));
  const zoomRef = useRef(zoom);
  const scrollRef = useRef(savedScroll);
  const stageRef = useRef<HTMLDivElement>(null);
  const restoreScroll = useRef(true);
  const saveTimer = useRef<number | undefined>(undefined);
  const dirty = useRef({ zoom: false, scroll: false });
  // Gesture handlers update memory immediately; storage is flushed after idle or on exit.
  const saveView = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = undefined;
    // A final scroll event can still be queued when iOS hides the page. Read
    // the live viewport before leaving, but never replace saved intent with
    // the zero offsets of a hidden or not-yet-restored reader.
    const stage = stageRef.current;
    if (!restoreScroll.current && stage?.isConnected && stage.clientWidth > 0 && stage.clientHeight > 0) {
      const next = { left: Math.max(0, stage.scrollLeft), top: Math.max(0, stage.scrollTop) };
      if (next.left !== scrollRef.current.left || next.top !== scrollRef.current.top) {
        scrollRef.current = next;
        dirty.current.scroll = true;
      }
    }
    if (dirty.current.zoom) writeUiState(zoomKey, zoomRef.current);
    if (dirty.current.scroll) writeUiState(scrollKey, scrollRef.current);
    dirty.current = { zoom: false, scroll: false };
  }, [zoomKey, scrollKey]);
  const scheduleSave = useCallback((field: 'zoom' | 'scroll') => {
    dirty.current[field] = true;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(saveView, 200);
  }, [saveView]);
  const changeZoom = useCallback((next: number | ((current: number) => number)) => {
    const value = clampPlateZoom(typeof next === 'function' ? next(zoomRef.current) : next);
    if (value === zoomRef.current) return;
    zoomRef.current = value;
    setZoom(value);
    scheduleSave('zoom');
  }, [scheduleSave]);
  const [viewer, setViewer] = useState<ViewerState>({});
  const [selectedPageIndex, setSelectedPageIndex] = useState(selection.document.pageIndex);
  const [rendering, setRendering] = useState(false);
  const [preparingMap, setPreparingMap] = useState(false);
  const [mapError, setMapError] = useState<string>();
  const mapPreparation = useRef<AbortController | undefined>(undefined);
  const [cacheState, setCacheState] = useState<PlateCacheState>('saving');
  const [downloadProgress, setDownloadProgress] = useState<ProcedureDownloadProgress>();
  const [painted, setPainted] = useState<{ document: PDFDocumentProxy; pageIndex: number;
    zoom: number; width: number; height: number }>();
  const [pixelRatio, setPixelRatio] = useState(displayPixelRatio);
  const renderCompletion = useRef<Promise<void>>(Promise.resolve());
  const [availableSize, setAvailableSize] = useState({ width: 0, height: 0 });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { document: source } = selection;
  const ready = Boolean(viewer.document && painted?.document === viewer.document && painted.pageIndex === pageIndex);
  const pinching = usePinchZoom(stageRef, canvasRef, zoom, changeZoom, ready);

  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === 'hidden') saveView(); };
    window.addEventListener('pagehide', saveView);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', saveView);
      document.removeEventListener('visibilitychange', onVisibility);
      saveView();
    };
  }, [saveView]);

  useEffect(() => {
    if (ready && painted?.zoom === zoom && restoreScroll.current) {
      stageRef.current?.scrollTo(scrollRef.current.left, scrollRef.current.top);
      restoreScroll.current = false;
    }
  }, [ready, painted, zoom]);

  useEffect(() => retainActiveFiles([source.url]), [source.url]);
  useEffect(() => () => mapPreparation.current?.abort(), [source]);

  useEffect(() => {
    const viewport = window.visualViewport;
    let timeout = 0;
    // External browser magnification can still change the pixel density.
    // Sharpen the PDF without changing its layout or the reader's position.
    const schedule = () => {
      window.clearTimeout(timeout);
      timeout = window.setTimeout(() => setPixelRatio(displayPixelRatio()), 120);
    };
    viewport?.addEventListener('resize', schedule);
    window.addEventListener('resize', schedule);
    return () => {
      window.clearTimeout(timeout);
      viewport?.removeEventListener('resize', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      if ((!event.ctrlKey && !event.metaKey) || !viewer.document) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1;
      changeZoom(value => value * Math.exp(-event.deltaY * unit * 0.01));
    };
    // React wheel handlers are passive: a trackpad pinch would also zoom the
    // browser if preventDefault were called there.
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [viewer.document, changeZoom]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const measure = () => {
      const style = getComputedStyle(stage);
      const height = Math.max(0, stage.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom));
      const width = Math.max(0, stage.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight));
      setAvailableSize(current => current.width === width && current.height === height ? current : { width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [source.source]);

  useEffect(() => {
    setViewer({});
    setCacheState('saving');
    setDownloadProgress(undefined);
    let current = true;
    let task: PDFDocumentLoadingTask | undefined;
    loadProcedureDocument(source, progress => { if (current) setDownloadProgress(progress); })
      .then(async ({ blob, cached }) => {
        if (!current) return;
        setDownloadProgress(undefined);
        setCacheState(cached ? 'cached' : 'unavailable');
        const range = new BlobRangeTransport(blob, error => {
          if (current) setViewer({ error: error instanceof Error ? error.message : 'Unable to read saved PDF' });
          void task?.destroy().catch(() => {});
        });
        task = getDocument({ range, disableStream: true, disableAutoFetch: true,
          verbosity: VerbosityLevel.ERRORS, useSystemFonts: true });
        const document = await task.promise;
        const targetIndex = await procedurePageIndex(document, source);
        const index = savedPage === null ? targetIndex : Math.min(savedPage, document.numPages - 1);
        if (current) {
          setSelectedPageIndex(targetIndex);
          setPageIndex(index);
          setViewer({ document });
        }
      })
      .catch((error: unknown) => {
        // A target lookup can fail after PDF.js has opened the document.
        void task?.destroy().catch(() => {});
        if (current) {
          setCacheState(state => state === 'saving' ? 'unavailable' : state);
          setViewer({ error: error instanceof Error ? error.message : 'Unable to open PDF' });
        }
      });
    return () => {
      current = false;
      void task?.destroy().catch(() => {});
    };
  }, [source]);

  useEffect(() => {
    const pdf = viewer.document;
    const canvas = canvasRef.current;
    if (!pdf || !canvas || pinching || preparingMap || availableSize.height <= 0 || availableSize.width <= 0) return;

    let current = true;
    let renderTask: ReturnType<Awaited<ReturnType<typeof pdf.getPage>>['render']> | undefined;
    setRendering(true);
    const previous = renderCompletion.current;
    renderCompletion.current = (async () => {
      // Wait for cancelled work to release its buffer before allocating another.
      await previous;
      if (!current) return;
      const page = await pdf.getPage(pageIndex + 1);
      if (!current) { page.cleanup(); return; }
      const buffer = window.document.createElement('canvas');
      try {
        const unscaled = page.getViewport({ scale: 1 });
        const fitScale = Math.min(availableSize.height / unscaled.height, availableSize.width / unscaled.width);
        const viewport = page.getViewport({ scale: fitScale * zoom });
        const size = pdfCanvasSize(viewport.width, viewport.height, pixelRatio);
        buffer.width = size.width;
        buffer.height = size.height;
        const context = buffer.getContext('2d', { alpha: false });
        if (!context) throw new Error('Canvas rendering is unavailable');
        renderTask = page.render({ canvas: buffer, canvasContext: context, viewport,
          transform: [buffer.width / viewport.width, 0, 0, buffer.height / viewport.height, 0, 0] });
        await renderTask.promise;
        if (!current) return;
        // Keep the previous bitmap visible until its replacement is complete.
        // Resizing and copying in one turn avoids a blank flash while zooming.
        const display = canvas.getContext('2d', { alpha: false });
        if (!display) throw new Error('Canvas rendering is unavailable');
        canvas.width = buffer.width;
        canvas.height = buffer.height;
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        display.drawImage(buffer, 0, 0);
        setPainted({ document: pdf, pageIndex, zoom, width: viewport.width, height: viewport.height });
        setRendering(false);
      } finally {
        buffer.width = buffer.height = 0;
        page.cleanup();
      }
    })().catch((error: unknown) => {
      if (!current || isRenderCancellation(error)) return;
      void pdf.loadingTask.destroy().catch(() => {});
      setRendering(false);
      setViewer({ error: error instanceof Error ? error.message : 'Unable to render PDF page' });
    });
    return () => {
      current = false;
      renderTask?.cancel();
    };
  }, [availableSize, pageIndex, viewer.document, zoom, pixelRatio, pinching, preparingMap]);

  const showOnMap = async () => {
    const pdf = viewer.document;
    if (!pdf || !onShowOnMap || mapPreparation.current || pageIndex !== selectedPageIndex) return;
    const controller = new AbortController();
    mapPreparation.current = controller;
    setPreparingMap(true);
    setMapError(undefined);
    try {
      const { preparePlateMapImage } = await import('./prepare-map-image');
      await renderCompletion.current;
      controller.signal.throwIfAborted();
      const image = await preparePlateMapImage(pdf, pageIndex, selection, controller.signal);
      if (controller.signal.aborted) image.canvas.width = image.canvas.height = 0;
      else onShowOnMap(image);
    } catch (error) {
      if (!controller.signal.aborted) setMapError(error instanceof Error ? error.message : 'Unable to show this plate on the map.');
    } finally {
      if (!controller.signal.aborted) setPreparingMap(false);
      mapPreparation.current = undefined;
    }
  };

  const pageCount = viewer.document?.numPages ?? source.pageCount ?? 1;
  const changePage = (next: number) => {
    setMapError(undefined);
    setPageIndex(Math.max(0, Math.min(pageCount - 1, next)));
    scrollRef.current = { left: 0, top: 0 };
    scheduleSave('scroll');
    stageRef.current?.scrollTo({ top: 0, left: 0 });
  };

  return <>
    {onShowOnMap && selection.procedure.kind === 'approach' && pageIndex === selectedPageIndex &&
      <ProcedureHeaderAction>
        <button type="button" className="procedure-show-on-map" disabled={!ready || rendering || pinching || preparingMap}
          onClick={() => void showOnMap()} aria-busy={preparingMap}
          aria-label={preparingMap ? 'Preparing map…' : 'Show on map'}
          title={preparingMap ? 'Preparing map…' : 'Show on map'}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Zm6-3v15m6-12v15" />
          </svg>
        </button>
      </ProcedureHeaderAction>}
    <div ref={stageRef} className={`procedure-page-stage${ready ? ' is-ready' : ''}`}
      onScroll={event => {
        if (!ready || restoreScroll.current) return;
        const next = { left: Math.max(0, event.currentTarget.scrollLeft), top: Math.max(0, event.currentTarget.scrollTop) };
        if (next.left === scrollRef.current.left && next.top === scrollRef.current.top) return;
        scrollRef.current = next;
        scheduleSave('scroll');
      }}
      aria-busy={!viewer.error && (!ready || rendering || pinching)}>
      {viewer.error ? <div className="procedure-error" role="alert">
        <strong>Unable to render this plate</strong>
        <span>{viewer.error}</span>
      </div> : <>
        <canvas ref={canvasRef} aria-label={`PDF page ${pageIndex + 1}`} aria-hidden={!ready}
          style={painted ? { width: painted.width * zoom / painted.zoom, height: painted.height * zoom / painted.zoom } : undefined} />
        {!ready && <ProcedurePageLoading source={source} progress={downloadProgress} />}
      </>}
    </div>
    <ProcedureFooter source={source} pageIndex={pageIndex} pageCount={pageCount} zoom={zoom} cacheState={cacheState}
      {...(viewer.document && !preparingMap ? { onPageChange: changePage, onZoomChange: changeZoom } : {})}
      mapAction={onShowOnMap && selection.procedure.kind === 'approach' ? <>
        {pageIndex !== selectedPageIndex && <button type="button" className="procedure-return-to-approach"
          disabled={!viewer.document || preparingMap} onClick={() => changePage(selectedPageIndex)}>Return to approach</button>}
        {mapError && <span className="procedure-map-error" role="alert">{mapError}</span>}
      </> : undefined} />
  </>;
}

function displayPixelRatio(): number {
  return (window.devicePixelRatio || 1) * Math.max(1, window.visualViewport?.scale || 1);
}

function isRenderCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === 'RenderingCancelledException';
}
