import { getDocument, GlobalWorkerOptions, VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { withAbort } from '../../core/data/abort';
import { BlobRangeTransport } from './blob-range';
import { loadProcedureDocument, type ProcedureDownloadProgress } from './document-cache';
import type { ProcedureDocument } from './data';

// Use the matching compatibility worker as well: Safari needs PDF.js's polyfills.
GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type ProgressListener = (progress: ProcedureDownloadProgress) => void;
type Progress = { latest?: ProcedureDownloadProgress; listeners: Set<ProgressListener> };
type Session = ReturnType<typeof createSession>;
const sessions = new Map<string, Session>();

/** Share the live parser as well as the file. PDF.js's range transport still
 * allocates a book-sized backing buffer in each document's worker. */
export async function openProcedurePdf(source: ProcedureDocument, signal: AbortSignal,
  onProgress?: ProgressListener) {
  signal.throwIfAborted();
  const key = JSON.stringify([source.url, source.sha256, source.byteLength]);
  let session = sessions.get(key);
  if (!session) {
    session = createSession(source);
    sessions.set(key, session);
    const current = session;
    current.controller.signal.addEventListener('abort', () => {
      if (sessions.get(key) === current) sessions.delete(key);
    }, { once: true });
    void current.ready.catch(error => current.controller.abort(error));
  }
  const owned = session;
  // Consumers must observe failures after opening too: destroying PDF.js can
  // otherwise look like an ordinary render cancellation or leave a query pending.
  const activeSignal = AbortSignal.any([signal, owned.controller.signal]);
  owned.readers++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    signal.removeEventListener('abort', release);
    if (onProgress) owned.progress.listeners.delete(onProgress);
    // Closing one reader must not destroy another reader's document. The last
    // owner releases the worker; a later opening starts a fresh session.
    if (--owned.readers === 0) owned.controller.abort();
  };
  signal.addEventListener('abort', release, { once: true });
  try {
    if (onProgress) {
      owned.progress.listeners.add(onProgress);
      if (owned.progress.latest) onProgress(owned.progress.latest);
    }
    return { ...await withAbort(owned.ready, activeSignal), signal: activeSignal, release };
  } catch (error) { release(); throw error; }
}

function createSession(source: ProcedureDocument) {
  const controller = new AbortController();
  const progress: Progress = { listeners: new Set() };
  const ready = loadPdf(source, controller, value => {
    if (controller.signal.aborted) return;
    progress.latest = value;
    for (const listener of progress.listeners) listener(value);
  });
  return { controller, progress, ready, readers: 0 };
}

async function loadPdf(source: ProcedureDocument, controller: AbortController, onProgress: ProgressListener) {
  const { signal } = controller;
  // Whole-file acquisition may finish caching after the final reader leaves.
  const { blob, cached } = await withAbort(loadProcedureDocument(source, onProgress), signal);
  signal.throwIfAborted();
  const range = new BlobRangeTransport(blob, error => controller.abort(error));
  const task = getDocument({ range, disableStream: true, disableAutoFetch: true,
    verbosity: VerbosityLevel.ERRORS, useSystemFonts: true });
  signal.addEventListener('abort', () => { void task.destroy().catch(() => {}); }, { once: true });
  return { document: await withAbort(task.promise, signal), cached };
}
