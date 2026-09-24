import assert from 'node:assert/strict';
import test from 'node:test';
import { MetarClient } from '../src/layers/metar-taf/metar/client';
import { metarReportSummary } from '../src/layers/metar-taf/metar/summary';

test('production service worker preserves METAR failures for product retry and stale labeling', async t => {
  let handleFetch!: (event: { request: Request; respondWith: (response: Promise<Response>) => void }) => void;
  const stored = new Map<string, Response>();
  const globals = {
    self: Object.assign(Object.create(globalThis), {
      location: { pathname: '/sw.js', origin: 'https://app.test' },
      addEventListener(type: string, callback: typeof handleFetch) { if (type === 'fetch') handleFetch = callback; },
    }),
    caches: { open: async () => ({
      match: async (request: Request) => stored.get(request.url)?.clone(),
      put: async (request: Request, response: Response) => { stored.set(request.url, response.clone()); },
    }) },
  };
  for (const [name, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, name, original) : Reflect.deleteProperty(globalThis, name));
  }
  await import('../src/service-worker');
  // Product caches remain authoritative even if browser settings replace the
  // caller's no-store mode. Never turn an upstream error into a cached success.
  let interceptedWeather = false;
  for (const path of ['metars.geojson', 'tafs.json', 'advisories/cwa.json', 'grids/clouds.json']) {
    for (const query of ['ids=KSFO', 'bbox=37,-123,38,-121']) {
      handleFetch({ request: new Request(`https://app.test/api/weather/${path}?${query}`),
        respondWith() { interceptedWeather = true; } });
    }
  }
  assert.equal(interceptedWeather, false);
  let now = Date.parse('2026-09-15T17:00:00Z');
  let upstreamStatus = 200;
  let calls = 0;
  const report = Response.json({ type: 'FeatureCollection', features: [{ type: 'Feature',
    geometry: { type: 'Point', coordinates: [-122, 37] },
    properties: { id: 'KSFO', obsTime: '2026-09-15T16:55:00Z', fltcat: 'VFR' },
  }] });
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return upstreamStatus === 200 ? report.clone() : new Response(null, { status: upstreamStatus });
  });
  const client = new MetarClient(new URL('https://app.test/api/weather/metars.geojson'), {
    now: () => now, retryDelayMs: 0,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      // An existing cached batch from an older application release must not hide errors.
      stored.set(request.url, report.clone());
      let response: Promise<Response> | undefined;
      handleFetch({ request, respondWith(value) { response = value; } });
      return response ?? fetch(request);
    },
  });
  await client.refresh(['KSFO'], new AbortController().signal);
  const checkedAt = client.snapshot().stations.get('KSFO')!.checkedAt;
  now += 60_000;
  upstreamStatus = 504;
  await client.refresh(['KSFO'], new AbortController().signal);
  const entry = client.snapshot().stations.get('KSFO')!;
  assert.equal(calls, 3, 'the failed refresh retries once instead of using SW fallback');
  assert.equal(entry.checkedAt, checkedAt);
  assert.match(entry.error!, /504/);
  assert.equal(metarReportSummary(entry, now).label, 'Cached report');
  assert.ok(metarReportSummary(entry, now).details.includes('Refresh unavailable'));
});
