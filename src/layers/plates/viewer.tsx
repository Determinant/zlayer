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
import { ProcedureFooter, ProcedurePageLoading, type PlateCacheState } from './viewer-dialog';
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

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type ProcedureViewerProps = {
  selection: ProcedureSelection;
};

type ViewerState = {
  document?: PDFDocumentProxy;
  error?: string;
};

export default function ProcedureViewer({ selection }: ProcedureViewerProps) {
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
  const saveTimer = useRef<number | undefined>(undefined);
  const dirty = useRef({ zoom: false, scroll: false });
  // Gesture handlers update memory immediately; storage is flushed after idle or on exit.
  const saveView = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = undefined;
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
  const restoreScroll = useRef(true);
  const [viewer, setViewer] = useState<ViewerState>({});
  const [rendering, setRendering] = useState(false);
  const [cacheState, setCacheState] = useState<PlateCacheState>('saving');
  const [downloadProgress, setDownloadProgress] = useState<ProcedureDownloadProgress>();
  const [painted, setPainted] = useState<{ document: PDFDocumentProxy; pageIndex: number;
    zoom: number; width: number; height: number }>();
  const [pixelRatio, setPixelRatio] = useState(displayPixelRatio);
  const renderCompletion = useRef<Promise<void>>(Promise.resolve());
  const [availableSize, setAvailableSize] = useState({ width: 0, height: 0 });
  const stageRef = useRef<HTMLDivElement>(null);
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
          void task?.destroy();
        });
        task = getDocument({ range, disableStream: true, disableAutoFetch: true,
          verbosity: VerbosityLevel.ERRORS, useSystemFonts: true });
        const document = await task.promise;
        const index = savedPage === null ? await procedurePageIndex(document, source) : Math.min(savedPage, document.numPages - 1);
        if (current) {
          setPageIndex(index);
          setViewer({ document });
        }
      })
      .catch((error: unknown) => {
        if (current) {
          setCacheState(state => state === 'saving' ? 'unavailable' : state);
          setViewer({ error: error instanceof Error ? error.message : 'Unable to open PDF' });
        }
      });
    return () => {
      current = false;
      void task?.destroy();
    };
  }, [source]);

  useEffect(() => {
    const pdf = viewer.document;
    const canvas = canvasRef.current;
    if (!pdf || !canvas || pinching || availableSize.height <= 0 || availableSize.width <= 0) return;

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
      setRendering(false);
      setViewer({ error: error instanceof Error ? error.message : 'Unable to render PDF page' });
    });
    return () => {
      current = false;
      renderTask?.cancel();
    };
  }, [availableSize, pageIndex, viewer.document, zoom, pixelRatio, pinching]);

  const pageCount = viewer.document?.numPages ?? source.pageCount ?? 1;
  const changePage = (next: number) => {
    setPageIndex(Math.max(0, Math.min(pageCount - 1, next)));
    scrollRef.current = { left: 0, top: 0 };
    scheduleSave('scroll');
    stageRef.current?.scrollTo({ top: 0, left: 0 });
  };

  return <>
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
      {...(viewer.document ? { onPageChange: changePage, onZoomChange: changeZoom } : {})} />
  </>;
}

function displayPixelRatio(): number {
  return (window.devicePixelRatio || 1) * Math.max(1, window.visualViewport?.scale || 1);
}

function isRenderCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === 'RenderingCancelledException';
}
