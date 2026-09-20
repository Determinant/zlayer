import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { type TestContext } from 'node:test';
import type { CatalogResponse } from '@zlayer/contracts';
import type { DownloadPlan } from '../src/offline/downloads';
import { CHART_CACHE, DATA_CACHE, PDF_CACHE } from '../src/core/storage/cache-names';

const records = new Map<string, unknown>();
Object.assign(globalThis, { onlineCacheTestRecords: records });
const loader = registerHooks({ resolve(specifier, context, next) {
  if (specifier.endsWith('/database') && /\/(offline|core\/storage)\//.test(context.parentURL ?? '')) return {
    url: 'data:text/javascript,' + encodeURIComponent(`
      export const readOfflineRecord = async key => globalThis.onlineCacheTestRecords.get(key);
      export const writeOfflineRecord = async (key, value) => value === undefined
        ? globalThis.onlineCacheTestRecords.delete(key) : globalThis.onlineCacheTestRecords.set(key, value);
      export const offlineRecords = async prefix => [...globalThis.onlineCacheTestRecords]
        .filter(([key]) => key.startsWith(prefix)).map(([,value]) => value);
      export const offlineRecordKeys = async prefix => [...globalThis.onlineCacheTestRecords.keys()].filter(key => key.startsWith(prefix));
    `), shortCircuit: true,
  };
  return next(specifier, context);
} });
const { pruneOnlineCache, ONLINE_CACHE_RETENTION_MS } = await import('../src/offline/cache-cleanup');
const { cacheAccessKey, noteCacheAccess } = await import('../src/core/storage/cache-access');
loader.deregister();

const feed = 'https://charts.tedyin.com/charts';
const old = `${feed}/2026-08-06`, current = `${feed}/2026-09-03`;
const now = Date.parse('2026-10-01T00:00:00Z');
const expired = now - ONLINE_CACHE_RETENTION_MS - 1;

function fixture(t: TestContext) {
  records.clear();
  const stores = new Map([CHART_CACHE, DATA_CACHE, PDF_CACHE].map(name => [name, new Map<string, Response>()]));
  const state = { busy: false, online: true, held: [] as { name: string }[], forgotten: [] as string[] };
  const globals = {
    location: { href: 'https://app.test/' },
    navigator: { get onLine() { return state.online; }, serviceWorker: { controller: {
      postMessage(message: { url: string }) { state.forgotten.push(message.url); },
    } }, locks: {
      request: async (_name: string, _options: unknown, callback: (lock: object | null) => Promise<unknown>) => callback(state.busy ? null : {}),
      query: async () => ({ held: state.held }),
    } },
    caches: { open: async (name: string) => ({
      keys: async () => [...stores.get(name)!.keys()].map(url => new Request(url)),
      delete: async (request: Request) => stores.get(name)!.delete(request.url),
    }) },
  };
  for (const [name, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, name, original) : Reflect.deleteProperty(globalThis, name));
  }
  const add = (cache: string, url: string, used: number | undefined = expired) => {
    stores.get(cache)!.set(url, new Response('file'));
    if (used !== undefined) records.set(cacheAccessKey(cache, url), used);
  };
  return { stores, state, add };
}

const catalog = (url: string): CatalogResponse => ({ schemaVersion: 1, revision: '2026-09-03',
  generatedAt: '2026-09-03T00:00:00Z', charts: [], weather: [],
  navigation: [{ id: 'airports', title: 'Airports', url, minZoom: 0, count: 1, sourceCount: 1 }],
});

test('online cache expiration protects all saved dependencies, previous versions and active tabs', async t => {
  const f = fixture(t);
  const chart = { kind: 'chart' as const, url: `${old}/saved.mbtiles`, byteLength: 100, sha256: 'a'.repeat(64) };
  const plan: DownloadPlan = { id: 'saved', regionId: 'us-CA', title: 'California', revision: '2026-08-06',
    files: [chart], references: [{ id: 'chart-supplements', url: `${old}/cs/catalog.json` }] };
  plan.previous = { ...plan, files: [{ ...chart, kind: 'pdf', url: `${old}/previous.pdf` }],
    references: [{ id: 'chart-supplements', url: `${old}/cs/previous.json` }] };
  records.set('region:saved', plan);
  for (const file of [chart, ...plan.previous.files]) f.add(file.kind === 'chart' ? CHART_CACHE : PDF_CACHE, file.url);
  for (const resource of [...plan.references, ...plan.previous.references]) f.add(DATA_CACHE, resource.url);
  const active = `${current}/nav/airports.geojson?v=active`;
  const otherTab = `${old}/nav/airports.geojson?v=other-tab`;
  f.add(DATA_CACHE, active); f.add(DATA_CACHE, otherTab);
  records.set('active-catalog:other', catalog(otherTab));
  const openPlate = `${old}/open-plate.pdf`;
  f.add(PDF_CACHE, openPlate);
  records.set('active-files:viewer', [openPlate]);
  f.state.held = [{ name: 'active-catalog:other' }, { name: 'active-files:viewer' }];
  for (const [cache, url] of [[CHART_CACHE, `${old}/unused.mbtiles`], [PDF_CACHE, `${old}/unused.pdf`],
    [DATA_CACHE, `${old}/nav/unused.json`]]) f.add(cache!, url!);
  f.add(DATA_CACHE, 'https://basemap.test/viewed.png');
  f.add(DATA_CACHE, 'https://app.test/weather/metars.geojson');
  assert.deepEqual(await pruneOnlineCache([catalog(active)], { now }), { removed: 3 });
  assert.deepEqual([...f.stores.get(CHART_CACHE)!.keys()], [chart.url]);
  assert.deepEqual([...f.stores.get(PDF_CACHE)!.keys()], [plan.previous.files[0]!.url, openPlate]);
  assert.ok(f.stores.get(DATA_CACHE)!.has(active));
  assert.ok(f.stores.get(DATA_CACHE)!.has(otherTab));
  assert.ok(f.stores.get(DATA_CACHE)!.has(plan.references[0]!.url));
  assert.ok(f.stores.get(DATA_CACHE)!.has(plan.previous.references[0]!.url));
  assert.ok(f.stores.get(DATA_CACHE)!.has('https://basemap.test/viewed.png'));
  assert.deepEqual(f.state.forgotten, [`${old}/unused.mbtiles`]);
});

test('recent use resets expiration and existing caches receive a full grace period', async t => {
  const f = fixture(t);
  const recent = `${old}/recent.pdf`, unknown = `${old}/unknown.pdf`;
  f.add(PDF_CACHE, recent); f.add(PDF_CACHE, unknown);
  records.delete(cacheAccessKey(PDF_CACHE, unknown));
  await noteCacheAccess(PDF_CACHE, recent, now);
  assert.deepEqual(await pruneOnlineCache([], { now }), { removed: 0 });
  assert.equal(records.get(cacheAccessKey(PDF_CACHE, unknown)), now);
  assert.deepEqual(await pruneOnlineCache([], { now: now + ONLINE_CACHE_RETENTION_MS + 1 }), { removed: 2 });
});

test('cleanup is throttled and defers offline, during downloads, or with unreadable retention roots', async t => {
  const f = fixture(t);
  f.add(CHART_CACHE, `${old}/file.mbtiles`);
  f.state.online = false;
  assert.equal((await pruneOnlineCache([], { now })).removed, 0);
  f.state.online = true; f.state.busy = true;
  assert.equal((await pruneOnlineCache([], { now })).removed, 0);
  f.state.busy = false;
  records.set('region:bad', { broken: true });
  await assert.rejects(pruneOnlineCache([], { now }), /could not be read/);
  records.delete('region:bad');
  f.state.held = [{ name: 'active-catalog:missing' }];
  await assert.rejects(pruneOnlineCache([], { now }), /could not be read/);
  assert.equal(f.stores.get(CHART_CACHE)!.size, 1);
  f.state.held = [];
  assert.equal((await pruneOnlineCache([], { now })).removed, 1);
  f.add(CHART_CACHE, `${old}/later.mbtiles`);
  assert.equal((await pruneOnlineCache([], { now: now + 60_000 })).removed, 0);
  assert.equal((await pruneOnlineCache([], { now: now + 60_000, force: true })).removed, 1);
});
