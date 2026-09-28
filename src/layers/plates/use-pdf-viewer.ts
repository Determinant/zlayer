import { useEffect, useRef, useState, type RefObject, type Dispatch, type SetStateAction } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { ProcedureSelection } from './data';
import type { PlateCacheState } from './viewer-dialog';
import type { ProcedureDownloadProgress } from './document-cache';
import { openProcedurePdf } from './pdf-document';
import { procedurePageIndex } from './page-target';
import { withAbort } from '../../core/data/abort';
import { pdfCanvasSize } from './render-scale';

type ViewerState = {
  document?: PDFDocumentProxy;
  signal?: AbortSignal;
  fail?: (error: unknown) => void;
  error?: string;
};

export function useProcedureDocument(source: ProcedureSelection['document'], savedPage: number | null,
  setPageIndex: (index: number) => void, onFailure: (error: unknown) => void) {
  const [viewer, setViewer] = useState<ViewerState>({});
  const [selectedPageIndex, setSelectedPageIndex] = useState(source.pageIndex);
  const [cacheState, setCacheState] = useState<PlateCacheState>('saving');
  const [downloadProgress, setDownloadProgress] = useState<ProcedureDownloadProgress>();
  useEffect(() => {
    setViewer({});
    setCacheState('saving');
    setDownloadProgress(undefined);
    let current = true;
    const controller = new AbortController();
    let stopObservingPdf = () => {};
    const fail = (error: unknown) => {
      if (!current || controller.signal.aborted) return;
      stopObservingPdf();
      controller.abort(error);
      onFailure(error);
      setDownloadProgress(undefined);
      setCacheState(state => state === 'saving' ? 'unavailable' : state);
      setViewer({ error: error instanceof Error ? error.message : 'Unable to read PDF' });
    };
    openProcedurePdf(source, controller.signal, progress => { if (current) setDownloadProgress(progress); })
      .then(async ({ document, cached, signal }) => {
        if (!current) return;
        const onFailure = () => fail(signal.reason);
        signal.addEventListener('abort', onFailure, { once: true });
        stopObservingPdf = () => signal.removeEventListener('abort', onFailure);
        signal.throwIfAborted();
        setDownloadProgress(undefined);
        setCacheState(cached ? 'cached' : 'unavailable');
        const targetIndex = await withAbort(procedurePageIndex(document, source), signal);
        const index = savedPage === null ? targetIndex : Math.min(savedPage, document.numPages - 1);
        if (current) {
          setSelectedPageIndex(targetIndex);
          setPageIndex(index);
          setViewer({ document, signal, fail });
        }
      })
      .catch(fail);
    return () => {
      current = false;
      stopObservingPdf();
      controller.abort();
    };
  }, [source]);

  return { viewer, selectedPageIndex, cacheState, downloadProgress };
}

export type PaintedPage = { document: PDFDocumentProxy; pageIndex: number;
  zoom: number; rotation: number; width: number; height: number };

export function useProcedureRender({ viewer, canvasRef, availableSize, pageIndex, zoom, rotation, pixelRatio,
  pinching, preparingMap, setPainted }: {
    viewer: ViewerState; canvasRef: RefObject<HTMLCanvasElement | null>; availableSize: { width: number; height: number };
    pageIndex: number; zoom: number; rotation: number; pixelRatio: number; pinching: boolean; preparingMap: boolean;
    setPainted: Dispatch<SetStateAction<PaintedPage | undefined>>;
  }) {
  const [rendering, setRendering] = useState(false);
  const renderCompletion = useRef<Promise<void>>(Promise.resolve());
  const renderWidth = availableSize.width;
  const hasRenderArea = renderWidth > 0 && availableSize.height > 0;
  useEffect(() => {
    if (!viewer.document) setRendering(false);
    const pdf = viewer.document;
    const signal = viewer.signal;
    const canvas = canvasRef.current;
    if (!pdf || !signal || !canvas || pinching || preparingMap || !hasRenderArea) return;

    let current = true;
    let renderTask: ReturnType<Awaited<ReturnType<typeof pdf.getPage>>['render']> | undefined;
    setRendering(true);
    const previous = renderCompletion.current;
    renderCompletion.current = (async () => {
      // Wait for cancelled work to release its buffer before allocating another.
      await previous;
      if (!current) return;
      const page = await withAbort(pdf.getPage(pageIndex + 1), signal);
      if (!current) { page.cleanup(); return; }
      const buffer = window.document.createElement('canvas');
      try {
        const pageRotation = (page.rotate + rotation) % 360;
        const unscaled = page.getViewport({ scale: 1, rotation: pageRotation });
        // 100% fills the reading width; taller pages scroll vertically from the top.
        const fitScale = renderWidth / unscaled.width;
        const viewport = page.getViewport({ scale: fitScale * zoom, rotation: pageRotation });
        const size = pdfCanvasSize(viewport.width, viewport.height, pixelRatio);
        buffer.width = size.width;
        buffer.height = size.height;
        const context = buffer.getContext('2d', { alpha: false });
        if (!context) throw new Error('Canvas rendering is unavailable');
        renderTask = page.render({ canvas: buffer, canvasContext: context, viewport,
          transform: [buffer.width / viewport.width, 0, 0, buffer.height / viewport.height, 0, 0] });
        await withAbort(renderTask.promise, signal);
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
        setPainted({ document: pdf, pageIndex, zoom, rotation, width: viewport.width, height: viewport.height });
        setRendering(false);
      } finally {
        buffer.width = buffer.height = 0;
        page.cleanup();
      }
    })().catch((error: unknown) => {
      if (!current || isRenderCancellation(error) && !signal.aborted) return;
      viewer.fail?.(signal.aborted ? signal.reason : error);
    });
    return () => {
      current = false;
      renderTask?.cancel();
    };
  }, [renderWidth, hasRenderArea, pageIndex, viewer.document, viewer.signal, viewer.fail, zoom, rotation, pixelRatio, pinching, preparingMap]);

  return { rendering, renderCompletion };
}

function isRenderCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === 'RenderingCancelledException';
}
