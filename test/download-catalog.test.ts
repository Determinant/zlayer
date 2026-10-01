import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { type TestContext } from 'node:test';
import type { CatalogResponse } from '@zlayer/contracts';
import { Hooks, hookModule } from './helpers/hooks';

const catalog: CatalogResponse = { schemaVersion: 1, revision: '2026-10-01',
  generatedAt: '2026-10-01T09:01:00Z', charts: [], navigation: [], weather: [] };
const state = { catalogs: 0, indexes: 0, fail: false, supplement: 1,
  airports: [], procedures: {}, catalog };
Object.assign(globalThis, { downloadCatalogTest: state });
const loader = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'react') return { url: hookModule, shortCircuit: true };
  const modules: Record<string, string> = {
    '../core/use-online': 'export const useOnline = () => true;',
    '../workspace/catalog/catalog': `export async function fetchLatestDownloadCatalog(signal) {
      signal.throwIfAborted(); const state = globalThis.downloadCatalogTest;
      state.catalogs++; return structuredClone(state.catalog);
    }`,
    '../layers/plates': `export async function fetchOfflinePlateIndex(catalog, fresh) {
      if (!fresh) throw new Error('Updates require fresh indexes');
      const state = globalThis.downloadCatalogTest; state.indexes++;
      if (state.fail) throw new Error('Index unavailable');
      return { airports: state.airports, procedures: state.procedures, supplements: { revision: state.supplement } };
    }`,
  };
  if (context.parentURL?.endsWith('/shell/use-download-catalog.ts') && modules[specifier]) {
    return { url: 'data:text/javascript,' + encodeURIComponent(modules[specifier]), shortCircuit: true };
  }
  return next(specifier, context);
} });
const { useDownloadCatalog } = await import('../src/shell/use-download-catalog');
loader.deregister();

function fixture(t: TestContext) {
  Object.assign(state, { catalogs: 0, indexes: 0, fail: false, supplement: 1, catalog });
  const hooks = new Hooks();
  Object.assign(globalThis, { testHooks: hooks });
  t.after(() => hooks.unmount());
  return (browsing = catalog, open = true) => hooks.render(() => useDownloadCatalog(browsing, open));
}

test('list and update share one refresh and unchanged metadata keeps prepared-plan inputs stable', async t => {
  const render = fixture(t);
  const first = render();
  const request = first.refresh();
  assert.equal(first.refresh(), request);
  const initial = await request;
  assert.equal(state.catalogs, 1);
  assert.equal(state.indexes, 1);
  render({ ...catalog });
  assert.equal(state.catalogs, 1, 'same-cycle browsing rerenders do not repeat discovery');
  const checked = await render().refresh();
  assert.equal(checked, initial, 'exact unchanged metadata retains the same catalog and index');
  assert.equal(state.indexes, 2);
  state.supplement++;
  const corrected = await render().refresh();
  assert.notEqual(corrected, initial, 'a correction is detected even without a changed catalog date/timestamp');
});

test('a failed index refresh keeps the last complete inputs and remains retryable', async t => {
  const render = fixture(t);
  const original = await render().refresh();
  state.fail = true;
  await assert.rejects(render().refresh(), /Index unavailable/);
  const failed = render();
  assert.equal(failed.catalog, original.catalog);
  assert.equal(failed.index, original.index);
  assert.equal(failed.checking, false);
  assert.equal(failed.error, 'Index unavailable');
  state.fail = false;
  await failed.refresh();
  assert.equal(render().error, undefined);
});
