import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserDownloads } from '../src/offline/browser-downloads';
import { isDownloadPlan } from '../src/offline/plan-records';
import { restoreDownloadPlan } from '../src/offline/compatibility/legacy-plans';
import { bookUrl, type CatalogResponse, type NavigationLayerRecord, type ChartSupplementCatalog } from '@zlayer/contracts';
import { fetchNavigation } from '../src/layers/navigation/api';
import { CHART_CACHE, PDF_CACHE, VERIFIED_SHA256_HEADER } from '../src/core/storage/cache-names';
import { cachedFileBytes } from '../src/offline/storage';
import { RegionDownloads, type DownloadPlan, type OfflineFile } from '../src/offline/downloads';
import { ResourceError } from '../src/core/data/errors';
import { cacheFixture } from './helpers/cache';
import { resource as routeHistory } from './helpers/route-history';

const plan: DownloadPlan = { id: 'test', regionId: 'us-AL', title: 'Alabama', revision: '2026-09-03', references: [],
  files: [{ kind: 'faa-pdf', url: 'https://aeronav.faa.gov/d-tpp/2609/HIGH.PDF?v=edition' }] };

test('durable selection validation permits only constrained FAA files without publisher identities', () => {
  assert.ok(isDownloadPlan(plan));
  for (const change of [
    { url: 'https://elsewhere.test/HIGH.PDF?v=edition' }, { url: 'https://aeronav.faa.gov/d-tpp/2609/HIGH.PDF' },
    { byteLength: 0 }, { kind: 'chart' }, { kind: 'pdf' },
  ]) assert.equal(isDownloadPlan({ ...plan, files: [{ ...plan.files[0], ...change }] }), false);
  assert.ok(isDownloadPlan({ ...plan, files: [{ kind: 'pdf', url: 'https://charts.test/book.pdf',
    byteLength: 123, sha256: 'a'.repeat(64) }] }), 'existing hosted-book selections stay valid');
  assert.equal(isDownloadPlan({ ...plan, references: [{ id: { toString: null }, url: 'invalid' }] }), false);
  assert.equal(isDownloadPlan({ ...plan, references: [routeHistory] }), true);
  assert.equal(isDownloadPlan({ ...plan, references: [{ ...routeHistory, uncompressedBytes: 0 }] }), false);
});

test('individual PDF sizes come only from durable, typed integrity receipts', async t => {
  const { stored } = cacheFixture(t, PDF_CACHE);
  assert.equal(await cachedFileBytes(plan.files[0]!), undefined);
  const response = new Response(null, { headers: { 'content-type': 'application/pdf', 'content-length': '789' } });
  stored.set(plan.files[0]!.url, response);
  assert.equal(await cachedFileBytes(plan.files[0]!), undefined);
  response.headers.set(VERIFIED_SHA256_HEADER, 'a'.repeat(64));
  assert.equal(await cachedFileBytes(plan.files[0]!), 789);
  response.headers.set('content-type', 'text/html');
  assert.equal(await cachedFileBytes(plan.files[0]!), undefined);
  response.headers.set('content-type', 'application/pdf');
  await (await caches.open(CHART_CACHE)).put('https://charts.test/a.mbtiles', response.clone());
  assert.equal(await cachedFileBytes({ kind: 'chart', url: 'https://charts.test/a.mbtiles', byteLength: 789, sha256: 'b'.repeat(64) }), undefined);
});

test('a 1,104-file first download releases receipt streams before they exhaust browser resources', async t => {
  const { stored, cache } = cacheFixture(t, CHART_CACHE);
  let open = 0, peak = 0, downloads = 0;
  t.mock.method(cache, 'match', async (url: RequestInfo | URL) => {
    const response = stored.get(String(url));
    if (!response) return undefined;
    const body = new ReadableStream({
      start() { peak = Math.max(peak, ++open); },
      cancel() { open--; },
    });
    return new Response(body, { headers: response.headers });
  });
  const files: OfflineFile[] = Array.from({ length: 1_104 }, (_, i) => ({ kind: 'chart',
    url: `https://charts.test/${i}.mbtiles`, byteLength: 123, sha256: 'a'.repeat(64) }));
  const manager = new RegionDownloads({
    list: async () => [], save: async () => {}, forget: async () => {},
    cachedBytes: cachedFileBytes, referencesReady: async () => true, prepare: async () => {},
    download: async file => {
      if (open > 32) throw new TypeError('Failed to fetch');
      downloads++;
      stored.set(file.url, new Response(null, { headers: {
        'content-length': '123', [VERIFIED_SHA256_HEADER]: 'a'.repeat(64),
      } }));
    },
    remove: async () => {}, exclusive: work => work(),
  });
  await manager.start({ ...plan, files });
  assert.equal(manager.snapshot()[0]!.state, 'complete');
  assert.equal(manager.snapshot()[0]!.completedFiles, 1_104);
  assert.equal(downloads, 1_104);
  assert.ok(peak <= 4, `receipt checks opened ${peak} streams at once`);
  assert.equal(open, 0);
});

test('bad receipt checks release their bodies without awaiting a stalled cancellation', async t => {
  const { cache } = cacheFixture(t, PDF_CACHE);
  let cancelled = 0;
  t.mock.method(cache, 'match', async () => new Response(new ReadableStream({
    cancel() { cancelled++; return new Promise<void>(() => {}); },
  }), { headers: { 'content-length': '789', 'content-type': 'text/html' } }));
  assert.equal(await cachedFileBytes(plan.files[0]!), undefined);
  assert.equal(cancelled, 1);
});

test('chart downloads preserve worker storage/integrity errors and classify transient HTTP failures', async t => {
  const manager = createBrowserDownloads(async () => {});
  const file: OfflineFile = { kind: 'chart', url: 'https://charts.test/test.mbtiles', byteLength: 1, sha256: 'a'.repeat(64) };
  for (const [status, workerCode, expected] of [
    [503, undefined, 'request'], [429, undefined, 'request'], [404, undefined, 'http'],
    [507, undefined, 'storage'], [503, 'storage', 'storage'], [503, 'invalid-data', 'invalid-data'],
  ] as const) {
    t.mock.method(globalThis, 'fetch', async () => new Response(null, { status,
      headers: workerCode ? { 'x-zlayer-error-code': workerCode } : {},
    }));
    await assert.rejects(manager.backend.download(file), error => error instanceof ResourceError && error.code === expected);
  }
});

test('restoring regions validates reference schemas and cycles without fetching or losing saved files', async t => {
  const { stored } = cacheFixture(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('verification must stay cache-only'); });
  const pdf = new Response('%PDF-1.7\n', { headers: { 'content-type': 'application/pdf', 'content-length': '9',
    [VERIFIED_SHA256_HEADER]: 'a'.repeat(64) } });
  await (await caches.open(PDF_CACHE)).put(plan.files[0]!.url, pdf);
  const urls = ['https://charts.test/nav/airways.json', 'https://charts.test/nav/airports.geojson'];
  const airports: NavigationLayerRecord = { id: 'airports', title: 'Airports', url: urls[1]!, minZoom: 0, count: 1, sourceCount: 1 };
  const saved: DownloadPlan = { ...plan, references: [
    { id: 'airways', title: 'Airways', url: urls[0]!, count: 1, sourceCount: 1 }, airports,
  ] };
  const metadata = { effectiveDate: plan.revision, source: 'FAA NASR' };
  const legacy = { type: 'ZLayerAirways', metadata, airways: [{ id: 'v55', ident: 'V55', points: ['FWA', 'GFK'],
    segments: [{ sequence: 1, from: 'FWA', to: 'GFK' }] }] };
  const valid = { ...legacy, airways: [{ ...legacy.airways[0], segments: [{ ...legacy.airways[0]!.segments[0], gap: true }] }] };
  const navigation = { type: 'FeatureCollection', metadata, features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-86.39, 32.3] }, properties: { kind: 'airport', ident: 'KMGM' } },
  ] };
  stored.set(urls[1]!, Response.json(navigation));
  const manager = createBrowserDownloads(async () => { throw new Error('verification must not download PDFs'); });
  manager.backend.list = async () => [saved];

  for (const [label, response] of [
    ['missing', undefined], ['legacy gap flags', Response.json(legacy)],
    ['wrong cycle', Response.json({ ...valid, metadata: { ...metadata, effectiveDate: '2026-08-06' } })],
    ['wrong airway count', Response.json({ ...valid, airways: [] })],
    ['invalid JSON', new Response('{')], ['failed HTTP status', Response.json(valid, { status: 503 })],
  ] as const) {
    if (response) stored.set(urls[0]!, response); else stored.delete(urls[0]!);
    await manager.restore();
    assert.equal(manager.snapshot()[0]!.state, 'paused', label);
    assert.equal(manager.snapshot()[0]!.completedFiles, 1, 'valid chart/PDF files remain saved');
  }
  stored.set(urls[0]!, Response.json(valid));
  await manager.restore();
  assert.equal(manager.snapshot()[0]!.state, 'complete');
  assert.equal((await fetchNavigation(airports, plan.revision, [])).features.length, 1, 'saved data is usable offline by the ordinary loader');
  stored.set(urls[1]!, Response.json({ ...navigation, features: [] }));
  await manager.restore();
  assert.equal(manager.snapshot()[0]!.state, 'paused', 'schema-valid but incomplete navigation is not Saved');
  assert.equal(manager.snapshot()[0]!.completedFiles, 1, 'failed reference checks preserve whole-file caches');
  stored.set(urls[1]!, Response.json({ ...navigation, metadata: { ...metadata, effectiveDate: '2026-08-06' } }));
  await manager.restore();
  assert.equal(manager.snapshot()[0]!.state, 'paused', 'every reference must match the saved cycle');
  assert.equal(fetch.mock.calls.length, 0);
});

test('legacy selections recover expectations only from matching cached catalog identities', async t => {
  const { stored } = cacheFixture(t);
  const airports: NavigationLayerRecord = { id: 'airports', title: 'Airports', minZoom: 0, count: 1, sourceCount: 1,
    url: '/nav/airports.geojson?v=original' };
  const catalog: CatalogResponse = { schemaVersion: 1, generatedAt: '2026-09-03T00:00:00Z', revision: plan.revision,
    charts: [], navigation: [airports], weather: [] };
  const { references, ...fields } = plan;
  const url = new URL(airports.url, 'https://charts.test/').href;
  const legacy = { ...fields, referenceUrls: [url] };
  const restored = restoreDownloadPlan(legacy, [catalog], 'https://charts.test/')!;
  assert.deepEqual(restored.references, [{ ...airports, url }]);
  assert.deepEqual(restored.files, plan.files);
  assert.ok(isDownloadPlan(restored));
  assert.equal(restoreDownloadPlan(restored, [], 'https://charts.test/'), restored);
  assert.equal(isDownloadPlan({ ...restored, references: [{ ...airports, sourceCount: -1 }] }), false);

  const manager = createBrowserDownloads(async () => { throw new Error('No downloads during migration'); });
  for (const catalogs of [[], [{ ...catalog, revision: '2026-08-06' }],
    [{ ...catalog, navigation: [{ ...airports, url: '/nav/airports.geojson?v=new-export' }] }]]) {
    const unknown = restoreDownloadPlan(legacy, catalogs, 'https://charts.test/')!;
    assert.deepEqual(unknown.references, [{ id: 'unverified', url }]);
    stored.set(url, Response.json({ cached: 'keep' }));
    assert.equal(await manager.backend.referencesReady(unknown), false);
    assert.ok(stored.has(url), 'unknown expectations must not evict cached data');
    await assert.rejects(manager.backend.prepare(unknown, new AbortController().signal), /Verify \/ update/);
  }
});

test('saved plans retain only one previous selection from the same region and cycle', () => {
  assert.ok(isDownloadPlan({ ...plan, previous: plan }));
  assert.equal(isDownloadPlan({ ...plan, previous: { ...plan, id: 'different' } }), false);
  assert.equal(isDownloadPlan({ ...plan, previous: { ...plan, regionId: 'us-NV' } }), false);
  assert.equal(isDownloadPlan({ ...plan, previous: { ...plan, revision: '2026-08-06' } }), false);
  assert.equal(isDownloadPlan({ ...plan, previous: { ...plan, previous: plan } }), false);
  assert.equal(isDownloadPlan({ ...plan, references: [{ id: 'chart-supplements', url: '/cs/catalog.json', snapshot: {} }] }), false);
});

test('shared supplement verification cannot hide a book omitted from another region plan', async t => {
  cacheFixture(t);
  const url = 'https://charts.test/cs/catalog.json';
  const volume = { id: 'SW', url: 'book.pdf', byteLength: 9, sha256: 'b'.repeat(64), pageCount: 1 };
  const snapshot: ChartSupplementCatalog = {
    schemaVersion: 1, builderVersion: 1, effectiveDate: '2026-09-03', expirationDate: '2026-10-29',
    generatedAt: '2026-09-03T00:00:00Z', sourceXml: { url: 'https://charts.test/cs.xml', sha256: 'a'.repeat(64) },
    volumes: [volume], airports: [{ faaId: 'SBA', name: 'Santa Barbara', city: 'Santa Barbara', state: 'CALIFORNIA',
      volumeId: 'SW', printedPage: '1', pageIndex: 0 }],
  };
  const book = { kind: 'pdf' as const, url: bookUrl(volume, url), byteLength: volume.byteLength, sha256: volume.sha256 };
  const complete: DownloadPlan = { ...plan, files: [...plan.files, book], references: [{ id: 'chart-supplements', url, snapshot }] };
  const missing = { ...complete, id: 'missing-book', files: plan.files };
  const cache = await caches.open(PDF_CACHE);
  for (const file of complete.files) await cache.put(file.url, new Response('%PDF-1.7\n', { headers: {
    'content-type': 'application/pdf', 'content-length': '9', [VERIFIED_SHA256_HEADER]: file.sha256 ?? 'a'.repeat(64),
  } }));
  const manager = createBrowserDownloads(async () => {});
  manager.backend.list = async () => [complete, missing];
  await manager.restore();
  assert.deepEqual(manager.snapshot().map(job => job.state), ['complete', 'paused']);
});
