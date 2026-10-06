import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { isCatalogResponse } from '@zlayer/contracts';
import { fetchChartCatalog, fetchLatestDownloadCatalog } from '../src/workspace/catalog/catalog';
import { retainCachedProducts } from '../src/workspace/catalog/saved-catalog';
import { chartRegionPlans } from '../src/layers/charts/offline';
import { cacheFixture } from './helpers/cache';

const first = '2026-09-03', notice = '2026-10-01', next = '2026-10-29';
const root = 'https://charts.tedyin.com/charts';
const bounds = [-180, -85.0511287798066, 180, 85.0511287798066];
const archive = { id: 'vfr-sectional-z0-r0-0-0', kind: 'vfr-sectional', zoom: 0,
  root: { z: 0, x: 0, y: 0 }, bounds, tileMask: '1', file: `vfr-sectional-z0-r0-0-0-${'a'.repeat(64)}.mbtiles`,
  sha256: 'a'.repeat(64), byteLength: 32768 };
const raster = (date: string) => ({ schemaVersion: 2, packagingVersion: 1, effectiveDate: date,
  generatedAt: `${date}T00:00:00Z`, maximumArchiveBytes: 4194304, archives: [archive], regions: [],
  charts: [{ id: 'chart', title: 'Sectional', kind: 'vfr-sectional', file: 'chart.mbtiles',
    bounds: [-125, 32, -114, 42], minZoom: 0, maxZoom: 0, byteLength: 32768,
    sha256: 'a'.repeat(64), cutlineProvenance: 'test' }] });

function fixture(t: TestContext) {
  cacheFixture(t);
  const requests: string[] = [];
  const absent = new Set<string>();
  const broken = new Map<string, number | object>();
  const rasters = new Set([first, next]);
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    assert.ok(url.startsWith(root), `Unexpected network request: ${url}`);
    requests.push(url);
    if (absent.has(url)) return new Response(null, { status: 404 });
    const failure = broken.get(url);
    if (failure !== undefined) return typeof failure === 'number'
      ? new Response(null, { status: failure }) : Response.json(failure);
    if (url === `${root}/cycles.json`) return Response.json({ schemaVersion: 1, cycles: [next, notice, first] });
    const date = url.slice(root.length + 1).split('/')[0]!;
    if (rasters.has(date) && url.endsWith('/mbtiles/manifest.json')) return Response.json(raster(date));
    if (url.endsWith('/nav/manifest.json')) return Response.json({ schemaVersion: 1, effectiveDate: date,
      generatedAt: `${date}T00:00:00Z`, products: ['airports', 'fixes', 'navaids', 'vfr-waypoints', 'airways']
        .map(id => ({ id, file: `${id}.json`, count: 1 })) });
    if (url.endsWith('/tpp/manifest.json')) return Response.json({ schemaVersion: 1, cycle: '2610',
      effectiveDate: date, expirationDate: '2026-11-26', generatedAt: `${date}T00:00:00Z`, airportCount: 1, procedureCount: 1 });
    return new Response(null, { status: 404 });
  });
  return { requests, absent, broken, rasters };
}

test('change notice uses current navigation and procedures with the valid older raster edition', async t => {
  const f = fixture(t);
  const old = await fetchChartCatalog(first);
  const current = await fetchChartCatalog(notice);
  assert.deepEqual(current.issues, []);
  assert.equal(current.revision, notice);
  assert.equal(current.charts[0]?.revision, first);
  assert.equal(current.chartPackages?.root, old.chartPackages?.root);
  assert.equal(current.charts[0]?.url, old.charts[0]?.url);
  assert.ok(current.navigation.every(layer => layer.url.includes(`/${notice}/nav/`)));
  assert.equal(current.procedures?.effectiveDate, notice);
  assert.ok(isCatalogResponse(current), 'mixed source dates survive persistence validation');
  assert.ok(!f.requests.some(url => url.includes(`/${next}/`)), 'future raster directories are never probed');
  const plan = (catalog: typeof current) => chartRegionPlans(catalog, 'https://zlayer.test/')
    .find(({ region }) => region.code === 'CA')!.plan;
  const a = plan(old), b = plan(current);
  assert.notEqual(a.id, b.id, 'new navigation cycle cannot overwrite an old saved region with the same raster root');
  assert.deepEqual(a.files, b.files, 'unchanged raster bytes and URLs are shared');
  assert.equal(b.revision, notice);
  assert.ok(b.references.every(reference => reference.url.includes(`/${notice}/nav/`)));
  const full = await fetchChartCatalog(next);
  assert.equal(full.charts[0]?.revision, next);
  assert.notEqual(full.chartPackages?.root, current.chartPackages?.root);
});

test('advertised raster dates bypass absent change-notice manifests without changing edition identity', async t => {
  const f = fixture(t);
  const current = await fetchChartCatalog(notice, undefined, [next, notice, first], { rasterRevisions: [next, first] });
  assert.deepEqual(current.issues, []);
  assert.equal(current.revision, notice);
  assert.equal(current.charts[0]?.revision, first);
  assert.equal(current.procedures?.effectiveDate, notice);
  assert.ok(current.navigation.every(layer => layer.url.includes(`/${notice}/nav/`)));
  assert.ok(f.requests.includes(`${root}/${first}/mbtiles/manifest.json`));
  assert.ok(!f.requests.some(url => url.includes(`/${notice}/mbtiles/`) || url.endsWith(`/${notice}/chart-manifest.json`)));
  assert.ok(!f.requests.some(url => url.includes(`/${next}/`)));
});

test('an advertised but missing raster publication is a feed error, not silent carryover', async t => {
  const f = fixture(t);
  f.rasters.delete(next);
  const current = await fetchChartCatalog(next, undefined, [next, notice, first], { rasterRevisions: [next, first] });
  assert.equal(current.charts.length, 0);
  assert.ok(current.issues.some(issue => issue.product === 'charts'));
  assert.ok(!f.requests.some(url => url.includes(`/${first}/`)));
});

test('availability metadata does not authorize carryover without current navigation and procedures', async t => {
  const f = fixture(t);
  f.absent.add(`${root}/${notice}/tpp/manifest.json`);
  const current = await fetchChartCatalog(notice, undefined, [notice, first], { rasterRevisions: [first] });
  assert.equal(current.charts.length, 0);
  assert.ok(current.issues.some(issue => issue.product === 'charts'));
  assert.ok(!f.requests.some(url => url.includes(`/${first}/`)));
});

test('published-cycle discovery is reused when the caller already has it', async t => {
  const f = fixture(t);
  const current = await fetchChartCatalog(notice, undefined, [next, first, notice, first]);
  assert.equal(current.charts[0]?.revision, first);
  assert.ok(!f.requests.includes(`${root}/cycles.json`));
});

test('missing next full edition cannot extend expired rasters into another cycle', async t => {
  const f = fixture(t);
  f.rasters.delete(next);
  const current = await fetchChartCatalog(next);
  assert.deepEqual(current.charts, []);
  assert.ok(current.issues.some(issue => issue.product === 'charts'));
  assert.ok(!f.requests.some(url => url.includes(`/${first}/`)));
});

for (const failure of ['navigation', 'procedures', 'chart-server', 'chart-invalid', 'older-invalid'] as const) {
  test(`carryover does not conceal ${failure} failures or incomplete publication`, async t => {
    const f = fixture(t);
    const url = failure === 'navigation' ? `${root}/${notice}/nav/manifest.json`
      : failure === 'procedures' ? `${root}/${notice}/tpp/manifest.json`
      : `${root}/${failure === 'older-invalid' ? first : notice}/mbtiles/manifest.json`;
    f.broken.set(url, failure.endsWith('invalid') ? { ...raster(first), effectiveDate: next } : 503);
    const current = await fetchChartCatalog(notice);
    assert.deepEqual(current.charts, []);
    assert.ok(current.issues.some(issue => issue.product === 'charts'));
    if (failure !== 'older-invalid') assert.ok(!f.requests.some(url => url.includes(`/${first}/`)));
  });
}

test('verified cached mixed-edition catalogs survive failed refreshes and retain exact URLs', async t => {
  const f = fixture(t);
  const saved = await fetchChartCatalog(notice);
  assert.equal(saved.charts[0]?.revision, first);
  for (const url of f.requests) f.absent.add(url);
  const offline = retainCachedProducts(await fetchChartCatalog(notice), saved);
  assert.deepEqual(offline.charts, saved.charts);
  assert.deepEqual(offline.chartPackages, saved.chartPackages);
  assert.ok(isCatalogResponse(offline));
  assert.equal(isCatalogResponse({ ...saved, revision: next, procedures: undefined }), false,
    'persisted charts cannot be relabeled past their effective interval');
  assert.equal(isCatalogResponse({ ...saved, charts: [{ ...saved.charts[0], revision: next }] }), false,
    'future imagery is not accepted for an older selected cycle');
});

test('regional update discovery advances at 0901Z and preserves individual product dates', async t => {
  const f = fixture(t);
  t.mock.method(Date, 'now', () => Date.parse('2026-10-01T09:00:59Z'));
  assert.equal((await fetchLatestDownloadCatalog()).revision, first);
  t.mock.method(Date, 'now', () => Date.parse('2026-10-01T09:01:00Z'));
  const latest = await fetchLatestDownloadCatalog();
  assert.equal(latest.revision, notice);
  assert.equal(latest.charts[0]!.revision, first);
  assert.ok(!f.requests.some(url => url.includes(`/${next}/`)));
});

test('regional updates refuse incomplete latest metadata instead of silently adopting an older edition', async t => {
  const f = fixture(t);
  t.mock.method(Date, 'now', () => Date.parse('2026-10-01T12:00:00Z'));
  await fetchLatestDownloadCatalog();
  f.broken.set(`${root}/${notice}/nav/manifest.json`, 503);
  await assert.rejects(fetchLatestDownloadCatalog(), /download metadata is unavailable/);
});

test('regional download discovery uses raster availability without probing the change notice', async t => {
  const f = fixture(t);
  t.mock.method(Date, 'now', () => Date.parse('2026-10-01T12:00:00Z'));
  f.broken.set(`${root}/cycles.json`, { schemaVersion: 1, cycles: [next, notice, first], rasterCycles: [next, first] });
  const latest = await fetchLatestDownloadCatalog();
  assert.equal(latest.revision, notice);
  assert.equal(latest.charts[0]!.revision, first);
  assert.ok(!f.requests.some(url => url.includes(`/${notice}/mbtiles/`) || url.endsWith(`/${notice}/chart-manifest.json`)));
  assert.ok(!f.requests.some(url => url.includes(`/${next}/`)));
});
