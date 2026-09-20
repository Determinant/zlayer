import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchJson } from '../src/core/data/fetch-json';
import { navigationDocumentGuard } from '../src/core/data/references';
import { fetchNavigationLayer } from '../src/workspace/catalog/catalog';
import { cacheFixture } from './helpers/cache';

test('production preserves validated manifest fallback and navigation export versions', async t => {
  let handleFetch!: (event: {
    request: Request; respondWith: (response: Promise<Response>) => void;
    waitUntil: (work: Promise<unknown>) => void;
  }) => void;
  const original = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { configurable: true, value: Object.assign(Object.create(globalThis), {
    location: { pathname: '/sw.js', origin: 'https://app.test' },
    addEventListener(type: string, callback: typeof handleFetch) { if (type === 'fetch') handleFetch = callback; },
  }) });
  t.after(() => original ? Object.defineProperty(globalThis, 'self', original) : Reflect.deleteProperty(globalThis, 'self'));
  await import('../src/service-worker');
  const revision = '2026-09-03';
  const root = `https://charts.tedyin.com/charts/${revision}/nav`;
  const manifest = `${root}/manifest.json`;
  const airportFile = `${root}/airports.geojson`;
  const published = { schemaVersion: 1, effectiveDate: revision, generatedAt: '2026-09-15T20:43:49Z',
    products: [{ id: 'airports', file: 'airports.geojson', count: 1 }] };
  const airport = { type: 'FeatureCollection', metadata: { effectiveDate: revision, source: 'FAA' },
    features: [{ type: 'Feature', id: 'KPAO', geometry: { type: 'Point', coordinates: [-122, 37] },
      properties: { ident: 'KPAO', runways: [{ id: '13/31', ends: [{ id: '13', trueHeadingDeg: 142, trafficPattern: 'left' }] }] } }] };

  for (const cacheMode of ['no-store', 'default'] as const) await t.test(`request cache mode: ${cacheMode}`, async t => {
    const { stored } = cacheFixture(t);
    const previous = { ...published, generatedAt: '2026-09-14T00:00:00Z' };
    stored.set(manifest, Response.json(previous));
    stored.set(airportFile, Response.json({ id: 'KPAO' }));
    let offline = false;
    const calls: string[] = [];
    const intercepted: string[] = [];
    const upstream = async (request: Request) => {
      calls.push(request.url);
      if (offline) throw new TypeError('offline');
      return Response.json(request.url === manifest ? published : airport);
    };
    const throughWorker = async (request: Request) => {
      let response: Promise<Response> | undefined;
      const pending: Promise<unknown>[] = [];
      handleFetch({ request, respondWith(value) { intercepted.push(request.url); response = value; },
        waitUntil(work) { pending.push(work); } });
      const result = await (response ?? upstream(request));
      await Promise.all(pending);
      return result;
    };
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input instanceof Request) return upstream(input); // Worker's upstream request.
      assert.equal(init?.cache, 'no-store');
      // Browser settings may replace the page's requested cache mode.
      return throughWorker(new Request(input, { ...init, cache: cacheMode }));
    });

    const layer = await fetchNavigationLayer(revision, 'airports');
    assert.equal(layer.url, `${airportFile}?v=${encodeURIComponent(published.generatedAt)}`);
    const readExport = () => fetchJson(layer.url, navigationDocumentGuard(layer, revision), 'Airports');
    assert.deepEqual(await readExport(), airport);
    assert.deepEqual(calls, [manifest, layer.url]);
    assert.deepEqual(await stored.get(manifest)!.clone().json(), published);
    assert.deepEqual(await stored.get(layer.url)!.clone().json(), airport);

    offline = true;
    // The page owns validated fallback; a raw manifest fetch through the worker does not.
    assert.deepEqual(await fetchNavigationLayer(revision, 'airports'), layer);
    assert.deepEqual(await readExport(), airport);
    assert.deepEqual(await (await throughWorker(new Request(layer.url))).json(), airport);
    assert.deepEqual(calls, [manifest, layer.url, manifest]);
    assert.deepEqual(intercepted.filter(url => url === manifest), []);
    assert.ok(intercepted.includes(layer.url), 'the worker can also serve the cached versioned export');

    stored.set(manifest, Response.json({ ...published, effectiveDate: '2026-10-01' }));
    await assert.rejects(fetchNavigationLayer(revision, 'airports'), /offline/);
    assert.equal(stored.has(manifest), false, 'an invalid cached manifest cannot become the offline fallback');
  });
});
