import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { type TestContext } from 'node:test';
import { Hooks, hookModule } from './helpers/hooks';
import type { ChartCatalog } from '../src/workspace/catalog/catalog';

const root = 'https://charts.tedyin.com/charts';
const records = new Map<string, unknown>();
const catalog = (revision: string): ChartCatalog => ({
  schemaVersion: 1, revision, generatedAt: `${revision}T00:00:00Z`, weather: [], issues: [],
  charts: [{ id: 'chart', title: 'Chart', kind: 'vfr-sectional', format: 'mbtiles', revision,
    bounds: [-125, 32, -114, 42], minZoom: 0, maxZoom: 0, byteLength: 32768, sha256: 'a'.repeat(64),
    url: `${root}/${revision}/mbtiles/chart.mbtiles` }],
  navigation: [{ id: 'airports', title: 'Airports', minZoom: 0, count: 1, sourceCount: 1,
    url: `${root}/${revision}/nav/airports.geojson` }],
});
const old = catalog('2026-09-03');
const fresh = catalog('2026-10-01');
const state = { revisions: [old.revision, fresh.revision, '2026-07-09'], offline: false,
  requests: [] as string[], unavailable: new Set<string>(), pending: new Map<string, Promise<ChartCatalog>>() };
Object.assign(globalThis, { testCycleRecords: records, testCycleFeed: state, testCycleCatalog: catalog });
const moduleUrl = (source: string) => 'data:text/javascript,' + encodeURIComponent(source);
const loader = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'react') return { url: hookModule, shortCircuit: true };
  if (specifier === '../../pwa') return { url: moduleUrl('export const preparePwa = async () => true;'), shortCircuit: true };
  if (specifier.endsWith('/storage/database')) return { url: moduleUrl(`
    export const readOfflineRecord = async key => globalThis.testCycleRecords.get(key);
    export const writeOfflineRecord = async (key, value) => value === undefined
      ? globalThis.testCycleRecords.delete(key) : globalThis.testCycleRecords.set(key, value);
    export const offlineRecords = async prefix => [...globalThis.testCycleRecords].filter(([key]) => key.startsWith(prefix)).map(([,value]) => value);
    export const offlineRecordKeys = async prefix => [...globalThis.testCycleRecords.keys()].filter(key => key.startsWith(prefix));
  `), shortCircuit: true };
  if (specifier === './catalog') return { url: moduleUrl(`
    export const fetchChartCatalog = async revision => {
      const state = globalThis.testCycleFeed;
      state.requests.push(revision);
      if (state.pending.has(revision)) return state.pending.get(revision);
      const catalog = globalThis.testCycleCatalog(revision);
      return state.offline || state.unavailable.has(revision)
        ? { ...catalog, charts: [], navigation: [], issues: [{ product: 'charts', message: 'unavailable' }, { product: 'navigation', message: 'unavailable' }] }
        : catalog;
    };
  `), shortCircuit: true };
  return next(specifier, context);
} });
const { useCatalog } = await import('../src/workspace/catalog/use-catalog');
const { savedCatalogs, saveCatalog } = await import('../src/workspace/catalog/saved-catalog');
const { fetchChartCycles, parseChartCycles } = await import('../src/workspace/catalog/cycles');
loader.deregister();

function fixture(t: TestContext) {
  records.clear(); state.offline = false; state.requests = []; state.unavailable.clear(); state.pending.clear();
  state.revisions = [old.revision, fresh.revision, '2026-07-09'];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    assert.equal(input, `${root}/cycles.json`);
    assert.equal(options?.cache, 'no-store');
    if (state.offline) throw new TypeError('offline');
    return Response.json({ schemaVersion: 1, generatedAt: '2026-09-17T00:00:00Z', cycles: state.revisions });
  };
  let hooks = new Hooks();
  const render = () => { Object.assign(globalThis, { testHooks: hooks }); return hooks.render(useCatalog); };
  // Flush async effects and the render they schedule, without wall-clock delays.
  const settled = async () => {
    for (let i = 0; i < 6; i++) { await new Promise(resolve => setImmediate(resolve)); render(); }
    return render();
  };
  const restart = async () => { hooks.unmount(); hooks = new Hooks(); render(); return settled(); };
  t.after(() => { hooks.unmount(); globalThis.fetch = originalFetch; });
  return { render, settled, restart };
}

test('latest is the default, discovers uncached dates, and updates across a restart without pinning', async t => {
  const f = fixture(t);
  state.revisions = [old.revision, '2026-07-09'];
  f.render();
  assert.equal((await f.settled()).catalog?.revision, old.revision);
  state.revisions.push(fresh.revision);
  const value = await f.restart();
  assert.equal(value.selection, 'latest');
  assert.equal(value.catalog?.revision, fresh.revision);
  assert.deepEqual(value.cycles, [fresh.revision, old.revision]);
  assert.equal(records.get(`catalog-selection:${root}`), 'latest');
  assert.ok(!state.requests.includes('2026-07-09'));
  assert.ok(records.has(`catalog:${root}:${old.revision}`), 'rollover preserves the old catalog');
});

test('an explicit date stays pinned and cached editions switch offline; Latest restores automatic selection', async t => {
  const f = fixture(t);
  f.render();
  (await f.settled()).selectCycle(old.revision);
  assert.equal((await f.settled()).catalog?.revision, old.revision);
  state.offline = true;
  let value = await f.restart();
  assert.equal(value.catalog?.revision, old.revision);
  assert.equal(value.selection, old.revision);
  assert.deepEqual(value.cycles, [fresh.revision, old.revision]);
  value.selectCycle('latest');
  value = await f.settled();
  assert.equal(value.catalog?.revision, fresh.revision);
  assert.equal((await f.restart()).selection, 'latest');
});

test('existing saved selections migrate unchanged, but invalid legacy editions are never selected', async t => {
  const f = fixture(t);
  records.set(`catalog:${root}:${old.revision}`, old);
  records.set(`catalog-selection:${root}`, old.revision);
  records.set('catalog:https://different.test/charts:2026-11-26', catalog('2026-11-26'));
  f.render();
  let value = await f.settled();
  assert.equal(value.catalog?.revision, old.revision);
  assert.deepEqual(value.cycles, [fresh.revision, old.revision]);
  records.set(`catalog:${root}:2026-07-09`, catalog('2026-07-09'));
  records.set(`catalog-selection:${root}`, '2026-07-09');
  value = await f.restart();
  assert.equal(value.catalog?.revision, fresh.revision);
  assert.ok(!value.cycles.includes('2026-07-09'));
});

test('late responses cannot replace the newly selected edition or its persisted preference', async t => {
  const f = fixture(t);
  let release!: (value: ChartCatalog) => void;
  state.pending.set(fresh.revision, new Promise(resolve => { release = resolve; }));
  f.render();
  (await f.settled()).selectCycle(old.revision);
  assert.equal((await f.settled()).catalog?.revision, old.revision);
  release(fresh);
  assert.equal((await f.settled()).catalog?.revision, old.revision);
  assert.equal(records.get(`catalog-selection:${root}`), old.revision);
});

test('partial newest uploads are skipped and failed switching keeps the active catalog and preference', async t => {
  const f = fixture(t);
  state.unavailable.add(fresh.revision);
  f.render();
  let value = await f.settled();
  assert.equal(value.catalog?.revision, old.revision);
  assert.equal(value.selection, 'latest');
  value.selectCycle(fresh.revision);
  value = await f.settled();
  assert.equal(value.catalog?.revision, old.revision);
  assert.equal(value.selection, 'latest');
  assert.match(value.error!, /unavailable/);
  assert.equal(records.get(`catalog-selection:${root}`), 'latest');
});

test('offline startup can recover saved catalogs without a saved cycle list', async t => {
  const f = fixture(t);
  records.set(`catalog:${root}:${old.revision}`, old);
  state.offline = true;
  f.render();
  const value = await f.settled();
  assert.equal(value.catalog?.revision, old.revision);
  assert.equal(value.selection, 'latest');
  assert.match(value.cycleNotice!, /saved editions/);
});

test('cycle indexes validate dates, exclude unsupported editions, and normalize ordering', () => {
  assert.deepEqual(parseChartCycles({ schemaVersion: 1,
    cycles: [old.revision, '2026-07-09', fresh.revision, old.revision] }), [fresh.revision, old.revision]);
  for (const value of [null, [], { schemaVersion: 2, cycles: [] }, { schemaVersion: 1 },
    { schemaVersion: 1, cycles: [old.revision, '2026-09-31'] },
    { schemaVersion: 1, cycles: [`${root}/${old.revision}/`] }]) {
    assert.throws(() => parseChartCycles(value), /Invalid FAA cycle index/);
  }
});

test('failed or aborted discovery never overwrites the last validated cycle list', async t => {
  fixture(t);
  const valid = await fetchChartCycles();
  state.revisions = ['2026-07-09'];
  assert.deepEqual(await fetchChartCycles(), { ...valid, stale: true });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fetchChartCycles(controller.signal), { name: 'AbortError' });
  assert.deepEqual(records.get(`catalog-cycles:${root}`), valid.revisions);
});

test('broken cycle indexes preserve cached dates and fail clearly without saved data', async t => {
  fixture(t);
  const valid = await fetchChartCycles();
  for (const response of [new Response(null, { status: 503 }), new Response('<html>fallback page</html>'),
    Response.json({ schemaVersion: 1, cycles: [old.revision, '2026-09-31'] })]) {
    globalThis.fetch = async input => {
      assert.equal(input, `${root}/cycles.json`);
      return response.clone();
    };
    assert.deepEqual(await fetchChartCycles(), { ...valid, stale: true });
    assert.deepEqual(records.get(`catalog-cycles:${root}`), valid.revisions);
  }
  records.clear();
  await assert.rejects(fetchChartCycles(), /Invalid FAA cycle index/);
});

test('empty failed catalogs never overwrite usable saved data', async t => {
  fixture(t);
  await saveCatalog(old);
  await saveCatalog({ ...old, charts: [], navigation: [] });
  assert.equal((await savedCatalogs()).catalog?.navigation.length, 1);
});

test('an evicted pinned catalog never mislabels a different saved map date', async t => {
  const f = fixture(t);
  records.set(`catalog:${root}:${old.revision}`, old);
  records.set(`catalog-selection:${root}`, fresh.revision);
  state.offline = true;
  f.render();
  const value = await f.settled();
  assert.equal(value.catalog?.revision, old.revision);
  assert.equal(value.selection, old.revision);
  assert.match(value.cycleNotice!, /Using FAA cycle Sep 3/);
  assert.match(value.error!, /Oct 1.* unavailable/);
  assert.equal(records.get(`catalog-selection:${root}`), fresh.revision, 'failed refresh preserves the requested preference');
});
