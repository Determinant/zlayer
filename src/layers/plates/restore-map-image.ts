import { getDocument, GlobalWorkerOptions, VerbosityLevel, type PDFDocumentLoadingTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { BlobRangeTransport } from './blob-range';
import { loadProcedureDocument } from './document-cache';
import { procedurePageIndex } from './page-target';
import { preparePlateMapImage } from './prepare-map-image';
import type { ProcedureSelection } from './data';
import type { PlateMapImage } from './map-image';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** Rebuild only the selected approach, never the reader's last browsed page. */
export async function restorePlateMapImage(selection: ProcedureSelection, signal: AbortSignal): Promise<PlateMapImage> {
  signal.throwIfAborted();
  const { blob } = await loadProcedureDocument(selection.document);
  signal.throwIfAborted();
  let task: PDFDocumentLoadingTask | undefined;
  let rangeError: unknown;
  const range = new BlobRangeTransport(blob, error => {
    rangeError = error;
    void task?.destroy().catch(() => {});
  });
  task = getDocument({ range, disableStream: true, disableAutoFetch: true,
    verbosity: VerbosityLevel.ERRORS, useSystemFonts: true });
  const abort = () => { void task?.destroy().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const pdf = await task.promise;
    signal.throwIfAborted();
    const pageIndex = await procedurePageIndex(pdf, selection.document);
    return await preparePlateMapImage(pdf, pageIndex, selection, signal);
  } catch (error) {
    throw rangeError ?? error;
  } finally {
    signal.removeEventListener('abort', abort);
    await task.destroy().catch(() => {});
  }
}
