import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { setImmediate as tick } from 'node:timers/promises';
import test from 'node:test';
import type { ProcedureDocument } from '../src/layers/plates/data';

const state = { starts: 0, live: 0, destroy: () => Promise.resolve() };
(globalThis as unknown as { pdfLifecycleTest: typeof state }).pdfLifecycleTest = state;
const moduleUrl = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
const pdf = moduleUrl(`
 const state = globalThis.pdfLifecycleTest;
 export const GlobalWorkerOptions = {}, VerbosityLevel = { ERRORS: 0 };
 export class PDFWorker {
   constructor() { state.live++; }
   destroy() { if (!this.destroyed) { this.destroyed = true; state.live--; } }
 }
 export class PDFDataRangeTransport {}
 export function getDocument() {
   state.starts++;
   return { promise: Promise.resolve({ numPages: 1 }), destroy: state.destroy };
 }
`);
const cache = moduleUrl('export async function loadProcedureDocument() { return { blob: new Blob(["PDF"]), cached: true }; }');
const loader = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'pdfjs-dist/legacy/build/pdf.mjs') return { url: pdf, shortCircuit: true };
  if (specifier.endsWith('pdf.worker.min.mjs?url')) return { url: moduleUrl('export default "test-worker"'), shortCircuit: true };
  if (specifier === './document-cache' && context.parentURL?.includes('/plates/pdf-document')) return { url: cache, shortCircuit: true };
  return next(specifier, context);
} });
const { openProcedurePdf } = await import('../src/layers/plates/pdf-document');
loader.deregister();
const source = (id: string): ProcedureDocument => ({ url: `https://test/${id}.pdf`, nativeUrl: `https://test/${id}.pdf`,
  source: 'faa-individual', pageIndex: 0 });
const signal = () => new AbortController().signal;

test('last-reader PDF retirement blocks rapid replacement parsers and skips cancelled queued books', async () => {
  let retire!: () => void;
  state.destroy = () => new Promise<void>(resolve => { retire = resolve; });
  const first = await openProcedurePdf(source('one'), signal());
  const secondReader = await openProcedurePdf(source('one'), signal());
  assert.equal(state.starts, 1); first.release();
  assert.equal(state.live, 1, 'the second reader still owns the parser');
  secondReader.release(); await tick();
  state.destroy = () => Promise.resolve();
  const starts = state.starts;
  for (let i = 0; i < 20; i++) {
    const controller = new AbortController();
    const cancelled = assert.rejects(openProcedurePdf(source(`cancel-${i}`), controller.signal), { name: 'AbortError' });
    await tick(); controller.abort(); await cancelled;
  }
  const replacement = openProcedurePdf(source('replacement'), signal());
  await tick(); assert.equal(state.starts, starts); assert.equal(state.live, 1);
  retire(); const opened = await replacement;
  assert.equal(state.starts, starts + 1); assert.equal(state.live, 1, 'retired worker terminates before replacement starts');
  opened.release(); await tick(); assert.equal(state.live, 0);
});

test('a rejected PDF task destroy still terminates its owned worker and permits a fresh session', async () => {
  state.destroy = () => Promise.reject(new Error('transport failed'));
  const first = await openProcedurePdf(source('failed-retirement'), signal());
  first.release();
  state.destroy = () => Promise.resolve();
  const replacement = await openProcedurePdf(source('failed-retirement'), signal());
  assert.equal(state.live, 1);
  replacement.release(); await tick(); assert.equal(state.live, 0);
});
