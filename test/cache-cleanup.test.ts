import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { DownloadPlan } from '../src/offline/downloads';
import { CHART_CACHE, PDF_CACHE } from '../src/core/storage/cache-names';

const state = { plans: [] as unknown[], locked: false };
Object.assign(globalThis, { testCleanupState: state });
const loader = registerHooks({ resolve(specifier, context, next) {
  if (specifier.endsWith('/storage/database') && /\/(browser-downloads|saved-plans)\.ts$/.test(context.parentURL ?? '')) return {
    url: 'data:text/javascript,' + encodeURIComponent(`
      export const offlineRecords = async prefix => prefix === 'region:' ? globalThis.testCleanupState.plans : [];
      export const writeOfflineRecord = async () => {};
      export const readOfflineRecord = async () => undefined;
    `), shortCircuit: true,
  };
  return next(specifier, context);
} });
const { removeUnsavedFiles, createBrowserDownloads } = await import('../src/offline/browser-downloads');
loader.deregister();

test('cleanup preserves shared and paused-region files, rejects lock contention and unreadable plans', async t => {
  const chart = { url: 'https://app.test/saved.mbtiles', kind: 'chart' as const, byteLength: 100, sha256: 'a'.repeat(64) };
  const book = { ...chart, url: 'https://app.test/saved.pdf', kind: 'pdf' as const };
  const plan: DownloadPlan = { id: 'one', regionId: 'us-CA', title: 'California', revision: '2026-09-03',
    files: [chart, book], references: [] };
  state.plans = [plan, { ...plan, id: 'two', files: [book] }];
  const stores = new Map([[CHART_CACHE, new Set([chart.url, 'https://app.test/unused.mbtiles'])],
    [PDF_CACHE, new Set([book.url, 'https://app.test/unused.pdf'])]]);
  const globals = {
    location: { href: 'https://app.test/' },
    navigator: { serviceWorker: { controller: { postMessage() {} } }, locks: {
      request: async (_name: string, _options: unknown, callback: (lock: object | null) => Promise<void>) =>
        callback(state.locked ? null : {}),
    } },
    caches: { open: async (name: string) => ({
      match: async (request: Request) => stores.get(name)?.has(request.url) ? new Response('file') : undefined,
      keys: async () => [...stores.get(name) ?? []].map(url => new Request(url)),
      delete: async (request: Request) => stores.get(name)?.delete(request.url) ?? false,
    }) },
  };
  for (const [name, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, name, original) : Reflect.deleteProperty(globalThis, name));
  }
  state.locked = true;
  await assert.rejects(removeUnsavedFiles(), /Another ZLayer window/);
  assert.equal(stores.get(CHART_CACHE)!.size, 2);
  state.locked = false;
  state.plans.push({ malformed: true });
  await assert.rejects(removeUnsavedFiles(), /could not be read/);
  assert.equal(stores.get(CHART_CACHE)!.size, 2);
  state.plans.pop();
  const previousBook = { ...book, url: 'https://app.test/previous.pdf' };
  plan.previous = { ...plan, files: [previousBook] };
  stores.get(PDF_CACHE)!.add(previousBook.url);
  await removeUnsavedFiles();
  assert.deepEqual([...stores.get(CHART_CACHE)!], [chart.url]);
  assert.deepEqual([...stores.get(PDF_CACHE)!], [book.url, previousBook.url]);

  const manager = createBrowserDownloads(async () => {});
  manager.backend.cachedBytes = async file => file.byteLength;
  manager.backend.referencesReady = async () => true;
  await manager.restore();
  const removed: string[] = [];
  manager.backend.remove = async file => { removed.push(file.url); };
  manager.backend.forget = async id => { removed.push(id); };
  state.plans.push({ id: 'unreadable', files: [chart] });
  await assert.rejects(manager.remove(plan.id), /could not be read/);
  assert.deepEqual(removed, [], 'an unreadable inventory must block both file deletion and record removal');
  assert.ok(manager.snapshot().some(job => job.id === plan.id));
});
