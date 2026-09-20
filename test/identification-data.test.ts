import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { readFileSync } from 'node:fs';
import type { GeoPointFeature } from '@zlayer/contracts';
import { nearbyVorStations } from '@zlayer/domain';
import { fetchNavigationLayer } from '../src/workspace/catalog/catalog';
import { fetchNavigation } from '../src/layers/navigation/api';
import { fillMissingNavaidAlignment } from '../src/layers/navigation/identification-data';
import { formatNavaidRadial, formatNavaidTrueBearing } from '../src/layers/navigation/nearby-navaids-format';
import { captureReference } from '../src/core/data/reference-snapshot';
import { cacheFixture } from './helpers/cache';

const published = JSON.parse(readFileSync(new URL('./fixtures/id-navaids.json', import.meta.url), 'utf8'));
const revision = '2026-09-03';
const root = `https://charts.tedyin.com/charts/${revision}/nav`;
const point: [number, number] = [-119 - 5 / 60 - 35 / 3600, 35];
const legacy = (): GeoPointFeature[] => structuredClone(published.features).map((feature: GeoPointFeature) => {
  delete feature.properties.stationDeclinationDeg;
  return feature;
});
const manifest = (second = 0) => ({ schemaVersion: 1, effectiveDate: revision,
  generatedAt: `2026-09-18T23:06:${String(second).padStart(2, '0')}Z`,
  products: [{ id: 'navaids', file: 'navaids.geojson', count: published.features.length }] });

function feed(t: TestContext, second: number, data = published) {
  const metadata = manifest(second);
  const url = `${root}/navaids.geojson?v=${encodeURIComponent(metadata.generatedAt)}`;
  const fetch = t.mock.method(globalThis, 'fetch', async (input: unknown) => {
    assert.ok(input === `${root}/manifest.json` || input === url, `Unexpected ID source: ${String(input)}`);
    return Response.json(input === url ? data : metadata);
  });
  return { url, fetch };
}

test('ID consumes the published chart source and reproduces real FAA station magnetic bearings', async t => {
  cacheFixture(t);
  const { url } = feed(t, 1);
  const layer = await fetchNavigationLayer(revision, 'navaids');
  assert.equal(layer.url, url);
  const data = await fetchNavigation(layer, revision, []);
  const stations = nearbyVorStations(point, data.features);
  assert.deepEqual(stations.map(station => station.feature.properties.ident), ['GMN', 'EHF', 'LHS', 'CMA']);
  // FAA NAV_BASE.csv MAG_VARN/MAG_VARN_HEMIS independently checked against this
  // published fixture. Golden TB values use 3D great-circle tangent projections;
  // expected MB subtracts the station's east-positive alignment, FROM the station.
  const expected = [
    [16, 315.94947471, 299.94947471, 'MB 300°', 'TB 316°'],
    [14, 179.58950201, 165.58950201, 'MB 166°', 'TB 180°'],
    [15, 306.95903087, 291.95903087, 'MB 292°', 'TB 307°'],
    [15, 0.07746095, 345.07746095, 'MB 345°', 'TB 360°'],
  ] as const;
  stations.forEach((station, index) => {
    const [alignment, tb, mb, mbLabel, tbLabel] = expected[index]!;
    assert.equal(station.feature.properties.stationDeclinationDeg, alignment);
    assert.ok(Math.abs(station.trueBearing! - tb) < 0.00001);
    assert.ok(Math.abs(station.radial! - mb) < 0.00001);
    assert.equal(formatNavaidRadial(station), mbLabel);
    assert.equal(formatNavaidTrueBearing(station), tbLabel);
  });
});

test('ID repairs a pinned old export without replacing its saved bytes or source identity', async t => {
  const { stored } = cacheFixture(t);
  const old = { ...published, features: legacy() };
  const layer = { id: 'navaids' as const, title: 'NAVAIDs', minZoom: 7,
    url: `${root}/navaids.geojson?v=old-snapshot`, count: 4, sourceCount: 4 };
  t.mock.method(globalThis, 'fetch', async () => Response.json(old));
  const saved = await captureReference(layer, revision);
  const baseline = await fetchNavigation(saved, revision, []);
  const before = structuredClone(baseline);
  const { url } = feed(t, 2);
  const completed = await fillMissingNavaidAlignment(baseline.features, revision);
  assert.deepEqual(nearbyVorStations(point, completed).map(station => formatNavaidRadial(station)),
    ['MB 300°', 'MB 166°', 'MB 292°', 'MB 345°']);
  assert.deepEqual(baseline, before);
  assert.deepEqual(await stored.get(saved.url)!.clone().json(), old);
  assert.deepEqual(await stored.get(url)!.clone().json(), published, 'supplement uses the ordinary durable offline cache');
});

test('alignment supplements require exact station identity and coordinates and preserve existing values', async t => {
  cacheFixture(t);
  feed(t, 3);
  const original: GeoPointFeature = legacy()[0]!;
  const candidates: GeoPointFeature[] = [
    { ...original, properties: { ...original.properties, stationDeclinationDeg: 0 } },
    { ...original, geometry: { type: 'Point', coordinates: [-119, 35] } },
    { ...original, id: 'another-station' },
    ...[{ ident: 'OTHER' }, { state: 'NV' }, { country: 'CA' }, { type: 'VOR' }]
      .map(properties => ({ ...original, properties: { ...original.properties, ...properties } })),
    { ...original, properties: { ...original.properties, name: 'Saved name', frequency: 'Saved frequency', status: 'Saved status' } },
  ];
  const completed = await fillMissingNavaidAlignment(candidates, revision);
  candidates.slice(0, -1).forEach((candidate, index) => assert.equal(completed[index], candidate));
  assert.deepEqual(completed.at(-1), { ...candidates.at(-1), properties: {
    ...candidates.at(-1)!.properties, stationDeclinationDeg: 15,
  } });
});

for (const [index, failure] of ['network', 'manifest cycle', 'export cycle', 'count', 'invalid alignment', 'ambiguous station'].entries()) {
  test(`an unavailable or invalid supplement preserves saved true bearings: ${failure}`, async t => {
    cacheFixture(t);
    const old = legacy();
    const metadata = manifest(10 + index);
    const data = structuredClone(published);
    if (failure === 'manifest cycle') metadata.effectiveDate = '2026-10-01';
    if (failure === 'export cycle') data.metadata.effectiveDate = '2026-10-01';
    if (failure === 'count') metadata.products[0]!.count++;
    if (failure === 'invalid alignment') data.features[0].properties.stationDeclinationDeg = '15';
    if (failure === 'ambiguous station') {
      data.features = data.features.flatMap((feature: GeoPointFeature) => [feature, feature]);
      metadata.products[0]!.count = data.features.length;
    }
    t.mock.method(globalThis, 'fetch', async (input: unknown) => {
      if (failure === 'network') throw new TypeError('offline');
      return Response.json(String(input).endsWith('/manifest.json') ? metadata : data);
    });
    const completed = await fillMissingNavaidAlignment(old, revision);
    assert.deepEqual(completed, old);
    const station = nearbyVorStations(point, completed)[0]!;
    assert.equal(station.radial, null);
    assert.equal(formatNavaidTrueBearing(station), 'TB 316°');
  });
}

test('complete exports need no extra request and cancelled supplements do not replace the view', async t => {
  const request = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected request'); });
  assert.equal(await fillMissingNavaidAlignment(published.features, revision), published.features);
  await assert.rejects(fillMissingNavaidAlignment(legacy(), revision, AbortSignal.abort()), { name: 'AbortError' });
  assert.equal(request.mock.calls.length, 0);
});

test('ID sees a rebuilt manifest even when browser settings override the request cache mode', async t => {
  const { stored } = cacheFixture(t);
  let handleFetch!: (event: { request: Request; respondWith: (response: Promise<Response>) => void;
    waitUntil: (work: Promise<unknown>) => void }) => void;
  const original = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { configurable: true, value: Object.assign(Object.create(globalThis), {
    location: { pathname: '/sw.js', origin: 'https://app.test' },
    addEventListener(type: string, callback: typeof handleFetch) { if (type === 'fetch') handleFetch = callback; },
  }) });
  t.after(() => original ? Object.defineProperty(globalThis, 'self', original) : Reflect.deleteProperty(globalThis, 'self'));
  await import('../src/service-worker');
  const old = manifest(20), current = manifest(21);
  stored.set(`${root}/manifest.json`, Response.json(old));
  const requests: string[] = [];
  const upstream = async (url: string) => {
    requests.push(url);
    return Response.json(url.endsWith('/manifest.json') ? current
      : new URL(url).searchParams.get('v') === current.generatedAt ? published : { ...published, features: legacy() });
  };
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input instanceof Request) return upstream(input.url); // Worker's upstream request.
    let response: Promise<Response> | undefined;
    handleFetch({ request: new Request(input, { ...init, cache: 'default' }),
      respondWith(value) { response = value; }, waitUntil() {} });
    return response ?? upstream(String(input));
  });
  const completed = await fillMissingNavaidAlignment(legacy(), revision);
  assert.equal(formatNavaidRadial(nearbyVorStations(point, completed)[0]!), 'MB 300°');
  assert.deepEqual(requests, [`${root}/manifest.json`,
    `${root}/navaids.geojson?v=${encodeURIComponent(current.generatedAt)}`]);
});
