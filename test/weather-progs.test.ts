import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSurfaceSnapshot, isSurfaceCatalog, SURFACE_MAX_BYTES, SURFACE_PROCESSING, surfacePositions, type SurfaceCatalog, type SurfaceProduct, type SurfaceSnapshot } from '@zlayer/contracts';
import { parseSurfaceCatalog, parseSurfaceChart, SURFACE_CATALOG } from '../src/layers/weather-awc/progs/source';
import { surfaceFrame, surfaceStatus } from '../src/layers/weather-awc/progs/time';
import { surfaceLineCurve } from '../src/layers/weather-awc/progs/curves';
import { ProgsClient } from '../src/layers/weather-awc/progs/client';
import { digest } from '../tools/weather-server/upstream';
import { createWeatherServer } from '../tools/weather-server/server';
import { WeatherCache } from '../tools/weather-server/cache';
import { resourceFor } from '../tools/weather-server/routes';
import { progsResource } from '../tools/weather-server/progs';
import { surfaceCatalog, surfaceChart } from './fixtures/wpc';
import { WEATHER_NOW } from './fixtures/awc-advisories';
import { cacheFixture } from './helpers/cache';

const HOUR = 3600_000;
const hash = (text: string) => digest(Buffer.from(text));
function localStorageFixture(t: TestContext) {
  const values = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: {
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value),
  } } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'window', previous) : Reflect.deleteProperty(globalThis, 'window'));
  return values;
}
function parse(product: SurfaceProduct): SurfaceSnapshot {
  const catalog = JSON.stringify(surfaceCatalog());
  const frames = parseSurfaceCatalog(catalog, WEATHER_NOW).filter(c => product === 'analysis' ? c.forecastHour === 0 : c.forecastHour > 0)
    .map(chart => { const text = JSON.stringify(surfaceChart(chart.file)); return parseSurfaceChart(text, chart, WEATHER_NOW, hash(text)); });
  return { schemaVersion: 2, product, checkedAt: WEATHER_NOW, source: SURFACE_CATALOG, sourceCatalog: catalog, sourceHash: hash(JSON.stringify(frames)), frames };
}

test('captured AWC charts retain all smoothed fronts/isobars and the full horizon survives file-cache restoration', async t => {
  const now = Date.parse('2026-09-24T19:00:00Z');
  const catalog = await readFile(new URL('./fixtures/wpc/2026-09-24-catalog.json', import.meta.url), 'utf8');
  const charts = parseSurfaceCatalog(catalog, now), frames = [];
  for (const chart of charts) {
    const text = await readFile(new URL(`./fixtures/wpc/${chart.file}`, import.meta.url), 'utf8');
    const frame = parseSurfaceChart(text, chart, now, hash(text));
    const raw = JSON.parse(text);
    assert.equal(frame.features.length, raw.features.length - 1, 'only the metadata record is not a map feature');
    assert.equal(frame.sourceDocument, text);
    assert.equal(frame.validTime, chart.validTime);
    assert.ok(frame.features.some(f => f.kind === 'ISOBAR'));
    assert.ok(frame.features.some(f => f.kind === 'LABEL' && /^\d{3,4}$/.test(f.text)));
    assert.ok(frame.features.some(f => f.kind === 'HIGH'));
    assert.ok(frame.features.some(f => f.kind === 'LOW'));
    for (const feature of frame.features) assert.deepEqual(feature.sourceProperties, raw.features[Number(feature.id.split(':')[1])].properties);
    for (const feature of frame.features.filter(f => 'phase' in f || f.kind === 'ISOBAR')) {
      const original = raw.features[Number(feature.id.split(':')[1])].geometry.coordinates;
      const geometry = feature.geometry;
      const positions = geometry.type === 'LineString' ? geometry.coordinates : geometry.type === 'MultiLineString' ? geometry.coordinates.flat() : [];
      assert.ok(positions.length >= (original.length - 1) * 16 + 1, 'every front and isobar has prepared AWC spline segments');
    }
    frames.push(frame);
  }
  for (const product of ['analysis', 'forecast'] as const) assert.equal(isSurfaceSnapshot({
    schemaVersion: 2, product, checkedAt: now, source: SURFACE_CATALOG, sourceCatalog: catalog, sourceHash: hash(catalog),
    frames: frames.filter(f => product === 'analysis' ? f.validTime === f.referenceTime : f.validTime > f.referenceTime),
  }), true);
  assert.equal(charts.at(-1)!.forecastHour, 168);
  assert.equal(new Set(frames.slice(1).map(f => f.referenceTime)).size, 2, 'published forecasts legitimately mix reference cycles');
  assert.ok(frames.some(f => f.features.some(feature => feature.kind === 'HURRICANE')));
  assert.ok(frames.some(f => f.features.some(feature => 'phase' in feature && feature.phase !== 'normal')));
  const forecast: SurfaceSnapshot = { schemaVersion: 2, product: 'forecast', checkedAt: now, source: SURFACE_CATALOG,
    sourceHash: hash(catalog), frames: frames.slice(1), sourceCatalog: catalog };
  assert.ok(JSON.stringify(forecast).length > 4 * 1024 * 1024, 'real contours exercise the expanded response and file budgets');
  assert.ok(JSON.stringify(forecast).length < SURFACE_MAX_BYTES, 'the full smoothed horizon fits the bounded prepared file');
  const values = localStorageFixture(t), { stored } = cacheFixture(t, 'zlayers-plugin-files-v1:weather-awc:progs-charts');
  const files = new Map<string, Buffer>();
  const published: SurfaceCatalog = { ...forecast, schemaVersion: 3, frames: forecast.frames.map(frame => {
    const body = Buffer.from(JSON.stringify({ schemaVersion: 1, processing: SURFACE_PROCESSING, product: 'forecast', frame }));
    const sha256 = digest(body), path = `forecast/${sha256}.json`;
    files.set(path, body);
    return { validTime: frame.validTime, referenceTime: frame.referenceTime, checkedAt: frame.checkedAt, source: frame.source,
      sourceHash: frame.sourceHash, path, sha256, byteLength: body.length, positions: surfacePositions(frame), documentLength: frame.sourceDocument.length };
  }) };
  const fetcher = t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname.replace('/api/weather/progs/', '');
    if (path === 'forecast.json') return Response.json(published);
    const body = files.get(path)!;
    return new Response(Uint8Array.from(body), { headers: { 'content-length': String(body.length) } });
  });
  const client = new ProgsClient('https://test/api/weather/progs/'), signal = new AbortController().signal;
  const expected = JSON.parse(JSON.stringify({ ...forecast, frames: forecast.frames.map((frame, i) => ({ ...frame, artifactHash: published.frames[i]!.sha256 })) }));
  assert.deepEqual(await client.refresh('forecast', signal, now), expected);
  assert.equal(stored.size, forecast.frames.length);
  assert.ok(values.get('zlayer-plugin:weather-awc:progs-forecast')!.length < 64 * 1024);
  fetcher.mock.mockImplementation(async () => { throw new Error('Offline'); });
  assert.deepEqual((await new ProgsClient(client.baseUrl).restore('forecast', signal)).snapshot, expected);
});

test('surface curves reproduce the captured AWC spline, preserve control points and remain bounded', async () => {
  const reference = JSON.parse(await readFile(new URL('./fixtures/wpc/awc-cardinal-reference.json', import.meta.url), 'utf8'));
  const curve = surfaceLineCurve(reference.controls);
  assert.equal(curve.length, reference.curve.length);
  curve.forEach((point, i) => point.forEach((coordinate, axis) => assert.ok(Math.abs(coordinate - reference.curve[i][axis]) <= 0.000005001,
    'AWC reference output agrees to half the stored coordinate precision')));
  reference.controls.forEach((point: [number, number], index: number) => assert.deepEqual(curve[index * 16], point));
  assert.deepEqual(surfaceLineCurve([[0, 0], [0, 0], [0, 0]]), Array.from({ length: 33 }, () => [0, 0]));
  assert.throws(() => surfaceLineCurve(Array.from({ length: 314 }, () => [0, 0])), /position limit/);
  // Closed NOAA contours use the same duplicated endpoints as AWC, not a
  // different cyclic spline. The source's closing point stays exact.
  const closed = [[-120, 40], [-118, 42], [-116, 40], [-118, 38], [-120, 40]] as [number, number][];
  const ring = surfaceLineCurve(closed);
  assert.deepEqual(ring[0], ring.at(-1));
  closed.forEach((point, i) => assert.deepEqual(ring[i * 16], point));
});

test('source labels remain independent; directed fronts reverse their pips and split at the date line', () => {
  const chart = parseSurfaceCatalog(JSON.stringify(surfaceCatalog()), WEATHER_NOW)[0]!;
  const doc = surfaceChart(chart.file);
  const label = doc.features.find(f => f.properties.text === 'RIDGE$')!;
  const cold = doc.features.find(f => f.properties.fcode === 420)!;
  cold.properties.fpipdr = 2;
  cold.geometry = { type: 'LineString', coordinates: [[179, 42], [-179, 40]] };
  doc.features.find(f => f.properties.type === 1)!.geometry = { type: 'LineString', coordinates: [[179, 42], [-179, 40]] };
  const text = JSON.stringify(doc), frame = parseSurfaceChart(text, chart, WEATHER_NOW, hash(text));
  const geometry = frame.features.find(f => f.kind === 'COLD')!.geometry;
  assert.equal(geometry.type, 'MultiLineString');
  if (geometry.type !== 'MultiLineString') return assert.fail('Expected a split curve');
  assert.deepEqual(geometry.coordinates[0]![0], [-179, 40]);
  assert.deepEqual(geometry.coordinates[0]!.at(-1), [-180, 41]);
  assert.deepEqual(geometry.coordinates[1]![0], [180, 41]);
  assert.deepEqual(geometry.coordinates[1]!.at(-1), [179, 42]);
  for (const part of geometry.coordinates) for (let i = 1; i < part.length; i++) assert.ok(Math.abs(part[i]![0] - part[i - 1]![0]) <= 180);
  const contour = frame.features.find(f => f.kind === 'ISOBAR')!.geometry;
  assert.equal(contour.type, 'MultiLineString');
  if (contour.type !== 'MultiLineString') return assert.fail('Expected a split isobar');
  assert.deepEqual(contour.coordinates, [...geometry.coordinates].reverse().map(part => [...part].reverse()), 'contours smooth and split without front-direction reversal');
  const ridge = frame.features.find(f => f.kind === 'LABEL' && f.text === 'RIDGE')!;
  assert.deepEqual(ridge.sourceProperties, label.properties);
  assert.equal('pressureHpa' in frame.features.find(f => f.kind === 'HIGH')!, false, 'no guessed center/pressure pairing');
  assert.ok(frame.features.some(f => f.kind === 'DRYLINE')); assert.ok(frame.features.some(f => f.kind === 'SQUALL'));
});

test('catalog identity, unknown records, wrong metadata, missing isobars and invalid geometry reject replacement', () => {
  const catalog = JSON.stringify(surfaceCatalog());
  for (const text of [catalog.replace('20260922_18', '20260230_18'), catalog.replace('20260922_18', '20260922_15'),
    catalog.replace('_F000_', '_F001_'), catalog.replace('20260922_18_F000_wpc.geojson', '../../malicious'), JSON.stringify({ prog: [] })]) {
    assert.throws(() => parseSurfaceCatalog(text, WEATHER_NOW));
  }
  const chart = parseSurfaceCatalog(catalog, WEATHER_NOW)[0]!, goodText = JSON.stringify(surfaceChart(chart.file));
  for (const invalid of [goodText.replace('"fcode":420', '"fcode":999'), goodText.replace('"fpipdr":1', '"fpipdr":7'),
    goodText.replace('"fhr":0', '"fhr":12'), goodText.replace('"type":1}', '"type":999}'),
    goodText.replace('[-122,38]', '[-122,99]'), goodText.replace('"code":"high"', '"code":"unknown"'), '<html>Unavailable</html>']) {
    assert.throws(() => parseSurfaceChart(invalid, chart, WEATHER_NOW, hash(invalid)));
  }
  const empty = surfaceChart(chart.file); empty.features = empty.features.filter(f => f.properties.type !== 1);
  assert.throws(() => parseSurfaceChart(JSON.stringify(empty), chart, WEATHER_NOW, hash(goodText)), /Incomplete/);
  const good = parse('analysis');
  assert.equal(isSurfaceSnapshot(good), true);
  assert.equal(isSurfaceSnapshot({ ...good, sourceHash: 'broken' }), false);
  assert.equal(isSurfaceSnapshot({ ...good, frames: [{ ...good.frames[0], referenceTime: WEATHER_NOW + HOUR }] }), false);
  const features = good.frames[0]!.features;
  assert.equal(isSurfaceSnapshot({ ...good, frames: [{ ...good.frames[0], features: [features[0], features[0]] }] }), false);
});

test('surface charts hold across other products’ stops, bridge to the first prog, and stop at the published horizon', () => {
  const analysis = parse('analysis'), forecast = parse('forecast');
  const records = { analysis: { snapshot: analysis, loading: false }, forecast: { snapshot: forecast, loading: false } };
  assert.equal(surfaceFrame(records, null, WEATHER_NOW).frame?.validTime, WEATHER_NOW - 3 * HOUR);
  assert.equal(surfaceFrame(records, null, WEATHER_NOW - 4 * HOUR).frame, undefined);
  assert.equal(surfaceFrame(records, null, WEATHER_NOW + 3 * HOUR).frame, undefined);
  assert.deepEqual(surfaceFrame(records, WEATHER_NOW + HOUR, WEATHER_NOW), {
    product: 'analysis', frame: analysis.frames[0], nextTime: forecast.frames[0]!.validTime,
  });
  assert.equal(surfaceFrame(records, WEATHER_NOW + 3 * HOUR - 1, WEATHER_NOW).frame, analysis.frames[0]);
  assert.equal(surfaceFrame(records, WEATHER_NOW + 3 * HOUR, WEATHER_NOW).frame, forecast.frames[0]);
  assert.equal(surfaceFrame(records, analysis.frames[0]!.validTime - 1, WEATHER_NOW).frame, undefined);
  assert.equal(surfaceFrame(records, WEATHER_NOW + HOUR, WEATHER_NOW + 3 * HOUR).frame, undefined, 'expired analysis does not bridge');
  assert.equal(surfaceFrame({ ...records, forecast: { loading: false } }, WEATHER_NOW + HOUR, WEATHER_NOW).frame, undefined, 'no assumed horizon without forecasts');
  assert.equal(surfaceFrame(records, WEATHER_NOW + 5 * HOUR, WEATHER_NOW).frame?.validTime, WEATHER_NOW + 3 * HOUR);
  const last = forecast.frames.at(-1)!, penultimate = forecast.frames.at(-2)!;
  assert.equal(surfaceFrame(records, last.validTime - 1, WEATHER_NOW).frame, penultimate);
  assert.equal(surfaceFrame(records, last.validTime, WEATHER_NOW).frame, last);
  assert.equal(surfaceFrame(records, last.validTime + 1, WEATHER_NOW).frame, undefined);
  for (let time = forecast.frames[0]!.validTime; time <= last.validTime; time += HOUR) {
    const expected = forecast.frames.filter(frame => frame.validTime <= time).at(-1);
    assert.equal(surfaceFrame(records, time, WEATHER_NOW).frame, expected, 'hourly grid stops retain the preceding native chart');
  }
  const sparse = { ...records, forecast: { snapshot: { ...forecast, frames: [forecast.frames[0]!, last] }, loading: false } };
  assert.equal(surfaceFrame(sparse, last.validTime - 1, WEATHER_NOW).frame, forecast.frames[0], 'a longer native interval also lasts until the next chart');
  assert.equal(surfaceStatus(records.analysis, WEATHER_NOW).label, 'Cached / unverified');
  assert.equal(surfaceStatus({ ...records.analysis, checkedAt: WEATHER_NOW }, WEATHER_NOW).label, 'Checked');
  assert.equal(surfaceStatus({ ...records.analysis, checkedAt: WEATHER_NOW }, WEATHER_NOW - 1).stale, true);
});

test('surface HTTP uses prepared files; restart, independent failures, rollback and same-cycle corrections retain honest identity', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zlayer-progs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = WEATHER_NOW, calls = 0, failAnalysis = false, failForecast = false, rollback = false, correction = false;
  const options = { directory, now: () => now, spacing: 0, startUpdates: false,
    fetch: (async (input: RequestInfo | URL) => {
      calls++;
      const url = new URL(String(input));
      if (url.href === SURFACE_CATALOG) {
        const catalog = surfaceCatalog();
        if (rollback) { catalog.prog[0]!.file = '20260922_15_F000_wpc.geojson'; catalog.prog[0]!.vsecs -= 3 * 3600; }
        return Response.json(catalog);
      }
      const file = url.pathname.split('/').pop()!, doc = surfaceChart(file);
      if (failForecast && file.includes('F168')) return new Response(null, { status: 404 });
      if (failAnalysis && file.includes('F000')) doc.features[1]!.properties.type = 999;
      if (correction && file.includes('F000')) doc.features[2]!.properties.text = '1025';
      return Response.json(doc);
    }) as typeof fetch };
  const app = await createWeatherServer(options);
  t.after(() => app.close());
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address(); assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/api/weather/progs/analysis.json`;
  assert.equal((await fetch(url)).status, 503); assert.equal(calls, 0, 'HTTP cannot acquire or parse NOAA data');
  app.progs.refresh(); await app.progs.close();
  const initialCalls = surfaceCatalog().prog.length + 1;
  assert.equal(calls, initialCalls, 'both families share one catalog acquisition');
  const first = await fetch(url);
  let text = await first.text();
  assert.equal(first.headers.get('x-weather-cache'), 'HIT');
  assert.equal(first.headers.get('x-weather-checked-at'), String(WEATHER_NOW));
  assert.equal(JSON.parse(text).schemaVersion, 3);
  assert.ok(isSurfaceCatalog(JSON.parse(text)));
  const responses = await Promise.all(Array.from({ length: 8 }, () => fetch(url).then(r => r.text())));
  assert.ok(responses.every(s => s === text)); assert.equal(calls, initialCalls);
  now += 6 * 60_000;
  app.progs.refresh(); await app.progs.close();
  const unchanged = JSON.parse(await (await fetch(url)).text()), original = JSON.parse(text);
  assert.equal(unchanged.sourceHash, original.sourceHash);
  assert.equal(unchanged.frames[0].path, original.frames[0].path, 'source checks reuse immutable geometry files');
  assert.equal(unchanged.checkedAt, now);
  assert.equal(unchanged.frames[0].checkedAt, now, 'a real source recheck updates freshness without changing geometry identity');
  text = JSON.stringify(unchanged);
  now += 6 * 60_000; failAnalysis = true;
  app.progs.refresh(); await app.progs.close();
  assert.equal(await (await fetch(url)).text(), text, 'a malformed replacement preserves the published analysis');
  const nextForecast = await app.cache.read(progsResource('forecast'));
  assert.equal(nextForecast?.checkedAt, now, 'analysis failure does not block forecasts');
  assert.match(app.progs.status.analysis!.error ?? '', /Unsupported/);
  now += 6 * 60_000; failAnalysis = false; failForecast = true;
  app.progs.refresh(); await app.progs.close();
  assert.equal((await app.cache.read(progsResource('forecast')))?.body.toString(), nextForecast!.body.toString(), 'one missing file cannot publish a partial forecast family');
  const latest = (await app.cache.read(progsResource('analysis')))!.body.toString();
  assert.equal(app.progs.status.analysis!.checkedAt, now);
  await app.close();
  const beforeRestart = calls, restarted = await createWeatherServer(options); t.after(() => restarted.close());
  assert.equal((await restarted.cache.read(progsResource('analysis')))?.body.toString(), latest);
  assert.equal(restarted.progs.status.analysis!.ready, true); assert.equal(calls, beforeRestart);
  now += 6 * 60_000; rollback = true; failForecast = false;
  restarted.progs.refresh(); await restarted.progs.close();
  assert.match(restarted.progs.status.analysis!.error ?? '', /older surface/);
  assert.equal((await restarted.cache.read(progsResource('analysis')))?.body.toString(), latest);
  now += 6 * 60_000; rollback = false; correction = true;
  restarted.progs.refresh(); await restarted.progs.close();
  const corrected = JSON.parse((await restarted.cache.read(progsResource('analysis')))!.body.toString());
  assert.equal(corrected.frames[0].referenceTime, JSON.parse(latest).frames[0].referenceTime);
  assert.notEqual(corrected.sourceHash, JSON.parse(latest).sourceHash);
  const correctedChart = JSON.parse((await restarted.cache.read(resourceFor(`/api/weather/progs/${corrected.frames[0].path}`)))!.body.toString());
  assert.equal(correctedChart.frame.features[1].text, '1025');
  await restarted.close();
  const afterCorrection = calls, freshRestart = await createWeatherServer(options); t.after(() => freshRestart.close());
  freshRestart.progs.refresh(); await freshRestart.progs.close();
  assert.equal(calls, afterCorrection, 'fresh prepared families survive a restart without immediate source acquisition');
  assert.equal(freshRestart.progs.status.forecast!.ready, true);
  assert.equal(freshRestart.progs.status.analysis!.checkedAt, now);
  const resource = progsResource('analysis'), prepared = (await freshRestart.cache.read(resource))!;
  const legacy = parse('analysis');
  legacy.sourceHash = hash('legacy-linear-isobars');
  const legacyBody = Buffer.from(JSON.stringify(legacy));
  await freshRestart.cache.put(resource, { ...prepared, body: legacyBody, sha256: digest(legacyBody),
    headers: { ...prepared.headers, 'x-weather-catalog': 'wpc-surface-v2-cardinal-v1' } });
  await freshRestart.close();
  const migrated = await createWeatherServer(options); t.after(() => migrated.close());
  assert.equal(migrated.progs.status.analysis!.ready, false, 'charts with straight isobars cannot masquerade as the new processor output');
  assert.equal(migrated.progs.status.forecast!.ready, true);
  migrated.progs.refresh(); await migrated.progs.close();
  const rebuilt = JSON.parse((await migrated.cache.read(resource))!.body.toString());
  assert.notEqual(rebuilt.sourceHash, legacy.sourceHash, 'processing changes invalidate the browser renderer identity');
  assert.ok(isSurfaceCatalog(rebuilt));
  assert.ok(await migrated.cache.read(resourceFor(`/api/weather/progs/${rebuilt.frames[0]!.path}`)));
});

test('grid retention changes cannot evict the published surface snapshots', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zlayer-progs-retention-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = new WeatherCache({ directory, maxBytes: 6, load: async () => { throw new Error('Unexpected acquisition'); } });
  await cache.restore();
  const analysis = progsResource('analysis'), forecast = progsResource('forecast'), grid = resourceFor('/api/weather/grids/clouds.json');
  const extra = resourceFor('/api/weather/grids/icing.json');
  const body = Buffer.from('{}'), payload = { body, status: 200, headers: {}, checkedAt: Date.now(), sha256: digest(body) };
  for (const resource of [analysis, forecast, grid]) await cache.put(resource, payload);
  cache.retain([analysis.key, forecast.key], 'progs');
  cache.retain([grid.key]);
  await assert.rejects(cache.put(extra, payload), { status: 507 });
  cache.retain([]);
  await cache.put(extra, payload);
  assert.equal(cache.has(analysis), true); assert.equal(cache.has(forecast), true);
  assert.equal(cache.has(grid), false); assert.equal(cache.has(extra), true);
});

test('client refreshes only the catalog for unchanged charts and optional saves do not delay live publication', async t => {
  const { cache, stored } = cacheFixture(t, 'zlayers-plugin-files-v1:weather-awc:progs-charts');
  const values = localStorageFixture(t), source = parse('analysis');
  const published = (snapshot: SurfaceSnapshot) => {
    const artifact = { schemaVersion: 1, processing: SURFACE_PROCESSING, product: snapshot.product, frame: snapshot.frames[0]! };
    const body = Buffer.from(JSON.stringify(artifact)), sha256 = digest(body), f = artifact.frame;
    const catalog: SurfaceCatalog = { ...snapshot, schemaVersion: 3, frames: [{ validTime: f.validTime, referenceTime: f.referenceTime,
      checkedAt: f.checkedAt, source: f.source, sourceHash: f.sourceHash, path: `analysis/${sha256}.json`, sha256,
      byteLength: body.length, positions: surfacePositions(f), documentLength: f.sourceDocument.length }] };
    return { catalog, body, snapshot: { ...snapshot, frames: [{ ...f, artifactHash: sha256 }] } };
  };
  let fixture = published(source), reads = 0;
  const fetcher = t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/analysis.json')) return Response.json(fixture.catalog);
    reads++; return new Response(Uint8Array.from(fixture.body), { headers: { 'content-length': String(fixture.body.length) } });
  });
  const client = new ProgsClient('https://app.test/api/weather/progs/'), signal = new AbortController().signal;
  assert.deepEqual(await client.refresh('analysis', signal, WEATHER_NOW), fixture.snapshot);
  assert.equal(reads, 1);
  await client.refresh('analysis', signal, WEATHER_NOW);
  assert.equal(reads, 1, 'unchanged files are not transferred or decoded again');
  assert.deepEqual(await client.restore('analysis', signal), { snapshot: fixture.snapshot, loading: false });
  assert.equal((await new ProgsClient('https://archive.test/').restore('analysis', signal)).snapshot, undefined);
  const pointer = values.get('zlayer-plugin:weather-awc:progs-analysis')!;
  assert.ok(pointer.length < 16 * 1024, 'the saved catalog contains references, not geometry');
  stored.clear();
  fetcher.mock.mockImplementation(async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/analysis.json')) return Response.json(fixture.catalog);
    throw new Error('Artifact temporarily unavailable');
  });
  assert.deepEqual(await client.refresh('analysis', signal, WEATHER_NOW), fixture.snapshot,
    'an optional repair failure cannot discard authenticated live charts');
  fetcher.mock.mockImplementation(async (input: RequestInfo | URL) => String(input).endsWith('/analysis.json') ? Response.json(fixture.catalog)
    : new Response(Uint8Array.from(fixture.body), { headers: { 'content-length': String(fixture.body.length) } }));
  const quota = t.mock.method(window.localStorage, 'setItem', () => { throw new DOMException('Full', 'QuotaExceededError'); });
  assert.deepEqual(await client.refresh('analysis', signal, WEATHER_NOW), fixture.snapshot);
  assert.equal(stored.size, 1, 'an unchanged refresh repairs a chart evicted by another weather cache');
  quota.mock.restore();
  fetcher.mock.mockImplementation(async () => Response.json({ ...fixture.catalog, product: 'forecast' }));
  await assert.rejects(client.refresh('analysis', signal, WEATHER_NOW));
  fixture = published({ ...source, sourceHash: hash('replacement'), frames: [{ ...source.frames[0]!, checkedAt: WEATHER_NOW + 1 }] });
  fetcher.mock.mockImplementation(async (input: RequestInfo | URL) => String(input).endsWith('/analysis.json') ? Response.json(fixture.catalog)
    : new Response(Uint8Array.from(fixture.body), { headers: { 'content-length': String(fixture.body.length) } }));
  let live!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { live = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const put = t.mock.method(cache, 'put', async () => { await gate; throw new Error('quota'); });
  const pending = client.refresh('analysis', signal, WEATHER_NOW + 1, live);
  await ready;
  assert.equal(values.get('zlayer-plugin:weather-awc:progs-analysis'), pointer);
  release();
  assert.deepEqual(await pending, fixture.snapshot);
  assert.equal(values.get('zlayer-plugin:weather-awc:progs-analysis'), pointer, 'failed publication preserves the old catalog');
  values.set('zlayer-plugin:weather-awc:progs-analysis', JSON.stringify({ endpoint: client.baseUrl, snapshot: source }));
  assert.deepEqual((await client.restore('analysis', signal)).snapshot, source, 'legacy snapshots remain readable offline');
  put.mock.restore();
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(client.restore('analysis', aborted.signal), { name: 'AbortError' });
});
