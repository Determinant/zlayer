import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, open, readdir, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WeatherCache } from '../tools/weather-server/cache';
import { createWeatherServer } from '../tools/weather-server/server';
import { HttpError, InvalidForecastSourceError, advisoryResource, modelResource, resourceFor } from '../tools/weather-server/routes';
import { createUpstream, digest, type Payload } from '../tools/weather-server/upstream';
import { sourceBlocks, sourceRecordKey } from '../tools/weather-server/source-records';
import { advisorySource, WEATHER_NOW } from './fixtures/awc-advisories';
import cwaNullHazard from './fixtures/awc-cwa-null-hazard.json';
import { isAwcAdvisorySnapshot } from '@zlayer/contracts';

const icing = 'dafs/prod/dafs.20260923/dafs.t00z.ifi.3km.conus.f001.grib2';
const metar = '/api/weather/metars.geojson?ids=KSFO&format=geojson';
const collection = { type: 'FeatureCollection', features: [] };
const indexBody = '1:0:d=2026092300:ICESEV:1000 m above mean sea level:1 hour fcst:\n';
const signal = new AbortController().signal;
const payload = (body = 'weather'): Payload => ({ body: Buffer.from(body), status: 200,
  headers: { 'content-type': 'application/json' }, checkedAt: Date.now(), sha256: digest(Buffer.from(body)) });
async function directory(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'zlayer-weather-'));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}
async function http(t: TestContext, fetcher: typeof fetch) {
  const app = await createWeatherServer({ directory: await directory(t), fetch: fetcher, spacing: 0, startUpdates: false });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  return { ...app, origin: `http://127.0.0.1:${address.port}` };
}
function grib() {
  const body = Buffer.alloc(32); body.write('GRIB'); body[7] = 2;
  body.writeBigUInt64BE(32n, 8); body.write('7777', 28); return body;
}

function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('gateway canonicalizes bounded queries and rejects arbitrary paths, queries and ranges', () => {
  assert.equal(resourceFor('/api/weather/metars.geojson?ids=ksfo,KOAK,KSFO').key,
    resourceFor('/api/weather/metars.geojson?format=geojson&ids=KOAK,KSFO').key);
  for (const path of ['//example.com/', '/weather/awc/../metars.geojson?ids=KSFO',
    '/api/weather/metars.geojson?ids=KSFO&ids=KOAK', '/api/weather/metars.geojson?ids=KSFO&url=https://evil.test',
    '/api/weather/metars.geojson?bbox=90,-120,91,-119', '/api/weather/metars.geojson#fragment',
    '/weather/awc/gairmet.json?date=2026-01-01', '/weather/noaa/gfs/prod/file', '/weather/%2e%2e/private']) {
    assert.throws(() => resourceFor(path), HttpError, path);
  }
  assert.throws(() => modelResource(icing.replace('20260923', '20260230') + '.idx'), { status: 400 });
  assert.throws(() => modelResource(icing + '.idx', undefined, 'a'.repeat(64)), { status: 400 });
  for (const range of ['', 'bytes=0-1,4-8', 'bytes=-20', 'bytes=20-1', 'bytes=0-8388608']) {
    assert.throws(() => modelResource(icing, range), { status: 416 });
  }
});

test('concurrent HTTP requests share one upstream read; hits retain the source-check timestamp', async t => {
  let calls = 0;
  const app = await http(t, async () => { calls++; return Response.json(collection); });
  const responses = await Promise.all(Array.from({ length: 12 }, () => fetch(app.origin + metar)));
  for (const response of responses) assert.deepEqual(await response.json(), collection);
  assert.equal(calls, 1);
  const hit = await fetch(app.origin + metar);
  assert.equal(hit.headers.get('x-weather-cache'), 'HIT');
  assert.equal(hit.headers.get('x-weather-checked-at'), responses[0]!.headers.get('x-weather-checked-at'));
  assert.equal(hit.headers.get('cache-control'), 'no-store');
  await hit.arrayBuffer();
  for (const path of ['/weather/noaa/' + icing, '/api/weather/noaa/' + icing, '/weather/awc/gairmet.json']) {
    assert.equal((await fetch(app.origin + path)).status, 404);
  }
  assert.equal((await fetch(app.origin + metar, { method: 'POST' })).status, 405);
});

test('shared cache fills finish once even after every viewer stops waiting', async t => {
  const started = gate<AbortSignal>(), finish = gate<Payload>();
  let calls = 0;
  const options = { directory: await directory(t), maxBytes: 4096,
    load: async (_resource: unknown, signal: AbortSignal) => { calls++; started.resolve(signal); return finish.promise; } };
  const cache = new WeatherCache(options);
  await cache.restore();
  const a = new AbortController(), b = new AbortController(), resource = resourceFor(metar);
  const first = cache.get(resource, undefined, a.signal), second = cache.get(resource, undefined, b.signal);
  const rejected = assert.rejects(first, { name: 'AbortError' }), otherRejected = assert.rejects(second, { name: 'AbortError' });
  const signal = await started.promise;
  a.abort(); await rejected;
  assert.equal(signal.aborted, false, 'the remaining viewer still needs this response');
  b.abort(); await otherRejected;
  assert.equal(signal.aborted, false, 'the server owns the fill after all viewers leave');
  finish.resolve(payload()); await cache.get(resource);
  assert.equal(calls, 1);
  assert.equal((await cache.get(resource)).hit, true);
});

test('server shutdown cancels shared work; a disconnected HTTP viewer does not', { timeout: 10_000 }, async t => {
  const started = gate<AbortSignal>(), canceled = gate<void>();
  const app = await http(t, async (_input, init) => {
    started.resolve(init!.signal!);
    await new Promise<void>((_resolve, reject) => init!.signal!.addEventListener('abort', () => {
      canceled.resolve(); reject(init!.signal!.reason);
    }, { once: true }));
    return Response.json(collection);
  });
  const controller = new AbortController();
  const request = assert.rejects(fetch(app.origin + metar, { signal: controller.signal }), { name: 'AbortError' });
  const upstreamSignal = await started.promise; controller.abort(); await request;
  assert.equal(upstreamSignal.aborted, false);
  await app.close(); await canceled.promise;
});

test('large catalogs use negotiated gzip without changing decoded content or source identity', async t => {
  const value = { ...collection, features: Array.from({ length: 100 }, () => ({ type: 'Feature', properties: { text: 'forecast'.repeat(30) } })) };
  const app = await http(t, async () => Response.json(value));
  const compressed = await fetch(app.origin + metar, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(compressed.headers.get('content-encoding'), 'gzip');
  assert.equal(compressed.headers.get('vary'), 'Accept-Encoding');
  assert.ok(Number(compressed.headers.get('content-length')) < JSON.stringify(value).length / 10);
  assert.deepEqual(await compressed.json(), value);
  for (const encoding of ['identity', 'gzip;q=0', 'gzip;q=0.000, br']) {
    const plain = await fetch(app.origin + metar, { headers: { 'Accept-Encoding': encoding } });
    assert.equal(plain.headers.get('content-encoding'), null);
    assert.equal(plain.headers.get('x-weather-sha256'), compressed.headers.get('x-weather-sha256'));
    assert.deepEqual(await plain.json(), value);
  }
});

test('disk cache survives restart, detects corrupt bodies, and bounds storage', async t => {
  const path = await directory(t); let calls = 0;
  const options = { directory: path, maxBytes: 14, load: async () => { calls++; return payload(); } };
  const cache = new WeatherCache(options); await cache.restore();
  const first = await cache.get(resourceFor(metar));
  const restarted = new WeatherCache(options); await restarted.restore();
  assert.equal((await restarted.get(resourceFor(metar))).checkedAt, first.checkedAt);
  assert.equal(calls, 1);
  const [name] = await readdir(path); assert.ok(name);
  await writeFile(join(path, name), 'broken');
  await restarted.get(resourceFor(metar)); assert.equal(calls, 2);
  await Promise.all(['KOAK', 'KSQL', 'KHWD'].map(id => restarted.get(resourceFor(metar.replace('KSFO', id)))));
  assert.ok(restarted.stats.bytes <= 14); assert.ok(restarted.stats.bytes >= 0);
  assert.ok((await readdir(path)).length <= 2);
});

test('warmer presence checks reuse authentication until raw or compressed file metadata changes', async t => {
  const path = await directory(t), resource = resourceFor('/api/weather/advisories/cwa.json');
  const options = { directory: path, maxBytes: 100_000, load: async () => { throw new Error('No upstream acquisition'); } };
  const cache = new WeatherCache(options); await cache.restore();
  const content = payload('weather'.repeat(1000)); await cache.put(resource, content);
  const handle = await open(join(path, (await readdir(path))[0]!), 'r');
  const prototype = Object.getPrototypeOf(handle) as FileHandle, stream = prototype.createReadStream;
  await handle.close();
  const reads = t.mock.method(prototype, 'createReadStream', function (this: FileHandle, ...args: Parameters<FileHandle['createReadStream']>) {
    return stream.apply(this, args);
  });
  for (let i = 0; i < 4; i++) assert.equal(await cache.check(resource), true);
  assert.equal(reads.mock.callCount(), 1, 'unchanged generations only check file metadata');
  const restarted = new WeatherCache(options); await restarted.restore();
  assert.equal(await restarted.check(resource), true); assert.equal(reads.mock.callCount(), 2);
  for (const encoding of ['gzip', 'raw'] as const) {
    if (encoding === 'raw') await restarted.put(resource, content);
    const saved = await restarted.open(resource, encoding === 'gzip'); assert.ok(saved);
    assert.equal(saved.gzip, encoding === 'gzip'); await saved.handle.close();
    const file = await open(saved.entry.file, 'r+');
    try {
      await file.write(Buffer.from([0]), 0, 1, saved.offset);
      const changed = new Date(Date.now() + 2000); await file.utimes(changed, changed);
    } finally { await file.close(); }
    assert.equal(await restarted.check(resource), false, `same-length ${encoding} damage is rejected`);
  }
  await restarted.put(resource, content);
  const saved = await restarted.open(resource); assert.ok(saved); await saved.handle.close();
  await rm(saved.entry.file); assert.equal(await restarted.check(resource), false);
});

test('restart rejects damaged cache metadata before accepting a saved response', async t => {
  for (const change of [{ headers: null }, { headers: { 'content-type': 'text/plain\r\ninvalid' } }, { status: 999 },
    { resource: { ...resourceFor(metar), ttl: null } }]) {
    const path = await directory(t), { body, ...response } = payload();
    const metadata = Buffer.from(JSON.stringify({ resource: resourceFor(metar), ...response, bytes: body.length, ...change }));
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(metadata.length);
    await writeFile(join(path, 'a.cache'), Buffer.concat([prefix, metadata, body]));
    let calls = 0;
    const cache = new WeatherCache({ directory: path, maxBytes: 4096, load: async () => { calls++; return payload(); } });
    await cache.restore();
    assert.equal(cache.stats.entries, 0);
    assert.deepEqual(await readdir(path), []);
    assert.equal((await cache.get(resourceFor(metar))).hit, false);
    assert.equal(calls, 1);
  }
});

test('optional persistence never bypasses response size, checksum or freshness validation', async t => {
  const resource = resourceFor(metar), now = Date.now();
  for (const value of [payload('x'.repeat(resource.maxBytes + 1)), { ...payload(), sha256: '0'.repeat(64) },
    { ...payload(), checkedAt: now + 1 }, { ...payload(), checkedAt: now - resource.ttl }]) {
    const cache = new WeatherCache({ directory: await directory(t), maxBytes: 4, now: () => now, load: async () => value });
    await cache.restore();
    await assert.rejects(cache.get(resource), HttpError);
    assert.equal(cache.stats.entries, 0);
  }
  const value = { ...payload(), checkedAt: now };
  const cache = new WeatherCache({ directory: await directory(t), maxBytes: 4, now: () => now, load: async () => value });
  await cache.restore();
  assert.deepEqual((await cache.get(resource)).body, value.body, 'valid data remains usable when only persistence fails');
  assert.equal(cache.stats.entries, 0);
});

test('expired source data refreshes; failed updates never extend freshness or serve expired success', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: WEATHER_NOW });
  const path = await directory(t); let calls = 0, fail = false;
  const cache = new WeatherCache({ directory: path, maxBytes: 1000, load: async () => {
    calls++; if (fail) throw new HttpError(503, 'offline', 30);
    return payload();
  } });
  await cache.restore();
  const resource = resourceFor(metar);
  await cache.get(resource);
  t.mock.timers.tick(31_000); await cache.get(resource);
  assert.equal(calls, 2);
  const checkedAt = (await cache.get(resource)).checkedAt;
  fail = true; t.mock.timers.tick(30_000);
  await assert.rejects(cache.get(resource), { status: 503 });
  await assert.rejects(cache.get(resource), { status: 503 });
  assert.equal(calls, 3);
  const restarted = new WeatherCache({ directory: path, maxBytes: 1000, load: async () => { throw new HttpError(502, 'offline'); } });
  await restarted.restore(); assert.equal(restarted.stats.entries, 0);
  assert.equal(checkedAt, WEATHER_NOW + 31_000);
});

test('IFI ranges use the index identity, preserve bytes and never cache a full-file or wrong-range reply', async t => {
  let reads = 0;
  const body = grib(), hash = digest(Buffer.from(indexBody));
  const app = await http(t, async (input, init) => {
    if (String(input).endsWith('.idx')) return new Response(indexBody);
    reads++; assert.equal(new Headers(init?.headers).get('range'), 'bytes=0-31');
    return new Response(new Uint8Array(body), { status: 206, headers: { 'Content-Range': 'bytes 0-31/32', 'Content-Length': '32' } });
  });
  for (let i = 0; i < 2; i++) {
    const response = await app.cache.get(modelResource(icing, 'bytes=0-31', hash));
    assert.equal(response.status, 206); assert.equal(response.headers['content-range'], 'bytes 0-31/32');
    assert.deepEqual(response.body, body);
  }
  assert.equal(reads, 1);
  await assert.rejects(app.cache.get(modelResource(icing, 'bytes=0-31', 'a'.repeat(64))), { status: 409 });
  assert.equal(reads, 1);
  for (const [status, contentRange] of [[200, 'bytes 0-31/32'], [206, 'bytes 1-32/33']] as const) {
    const upstream = createUpstream({ signal, spacing: 0, fetch: async () => new Response(new Uint8Array(body), { status, headers: { 'Content-Range': contentRange } }) });
    await assert.rejects(upstream(modelResource(icing, 'bytes=0-31')), { status: 502 });
  }
});

test('adjacent IFI records share bounded downloads without crossing gaps or source identities', () => {
  const first = { path: icing, indexHash: 'a'.repeat(64), start: 0, end: 31 };
  const second = { ...first, start: 32, end: 63 };
  const gap = { ...first, start: 96, end: 127 };
  const changed = { ...second, indexHash: 'b'.repeat(64) };
  const last = { path: icing, indexHash: first.indexHash, start: 128 };
  const records = [last, changed, first, gap, second, first];
  const blocks = sourceBlocks(records), get = (record: typeof records[number]) => blocks.get(sourceRecordKey(record))!;
  assert.equal(get(first), get(second));
  assert.equal(get(first).resource.range, 'bytes=0-63');
  assert.equal(get(first).resource.multipleGribs, true);
  assert.equal(get(gap).resource.range, 'bytes=96-127');
  assert.notEqual(get(second), get(changed));
  assert.equal(get(last).resource.range, 'bytes=128-');
  assert.equal(new Set(blocks.values()).size, 4);
  const large = [0, 4, 8].map(start => ({ ...first, start: start * 1024 * 1024, end: (start + 4) * 1024 * 1024 - 1 }));
  const ranges = [...new Set(sourceBlocks(large).values())].map(block => block.resource.range);
  assert.deepEqual(ranges, ['bytes=0-8388607', 'bytes=8388608-12582911']);
});

test('combined GRIB ranges validate every message boundary and remain strict for single records', async () => {
  let body = Buffer.concat([grib(), grib()]);
  const upstream = createUpstream({ signal, spacing: 0, fetch: async () => new Response(new Uint8Array(body), {
    status: 206, headers: { 'Content-Range': 'bytes 0-63/64' },
  }) });
  const resource = modelResource(icing, 'bytes=0-63');
  await assert.rejects(upstream(resource), InvalidForecastSourceError);
  assert.deepEqual((await upstream({ ...resource, multipleGribs: true })).body, body);
  for (const offset of [32, 39, 47, 60]) {
    body = Buffer.concat([grib(), grib()]); body[offset] = 0;
    await assert.rejects(upstream({ ...resource, multipleGribs: true }), InvalidForecastSourceError);
  }
});

test('G-AIRMET refresh pins all five frames and retains freezing lines and heights; mixed cycles fail', async () => {
  const dates: string[] = []; let mixed = false;
  const upstream = createUpstream({ signal, spacing: 0, fetch: async input => {
    const url = new URL(String(input)), hour = Number(url.searchParams.get('fore'));
    dates.push(url.searchParams.get('date')!);
    return Response.json(advisorySource('gairmet', hour, WEATHER_NOW + (mixed && hour === 9 ? 3_600_000 : 0)));
  } });
  const resource = advisoryResource('gairmet');
  const data = JSON.parse((await upstream(resource)).body.toString());
  assert.equal(data.length, 5); assert.equal(new Set(dates).size, 1);
  assert.equal(data[4].features[1].geometry.type, 'LineString');
  assert.equal(data[4].features[1].properties.level, '120');
  mixed = true; await assert.rejects(upstream(resource), { status: 502 });
});

test('gateway serves and caches the complete CWA family when AWC omits a hazard classification', async t => {
  let calls = 0;
  const app = await http(t, async input => {
    assert.equal(new URL(String(input)).pathname, '/api/data/cwa');
    calls++;
    return Response.json(cwaNullHazard);
  });
  const response = await fetch(app.origin + '/api/weather/advisories/cwa.json');
  assert.equal(response.status, 200);
  const snapshot: unknown = await response.json();
  assert.ok(isAwcAdvisorySnapshot(snapshot));
  assert.deepEqual(snapshot.advisories.map(a => [a.issuer, a.hazard]), [['ZHU', 'UNK'], ['ZKC', 'TS']]);
  const cached = await fetch(app.origin + '/api/weather/advisories/cwa.json');
  assert.equal(cached.status, 200);
  assert.equal(cached.headers.get('x-weather-cache'), 'HIT');
  assert.deepEqual(await cached.json(), snapshot);
  assert.equal(calls, 1);
});

test('only METAR/TAF reports accept 204; advisory emptiness requires a complete GeoJSON document', async () => {
  const upstream = createUpstream({ signal, spacing: 0, fetch: async () => new Response(null, { status: 204 }) });
  assert.deepEqual(JSON.parse((await upstream(resourceFor(metar))).body.toString()), collection);
  assert.deepEqual(JSON.parse((await upstream(resourceFor('/api/weather/tafs.json?ids=KSFO'))).body.toString()), []);
  for (const product of ['sigmet', 'cwa'] as const) {
    const resource = advisoryResource(product);
    await assert.rejects(upstream(resource), { status: 502 });
    const empty = createUpstream({ signal, spacing: 0, fetch: async () => Response.json(collection) });
    assert.deepEqual(JSON.parse((await empty(resource)).body.toString()), collection);
  }
  let missing = true;
  const packageUpstream = createUpstream({ signal, spacing: 0, fetch: async input => {
    const hour = Number(new URL(String(input)).searchParams.get('fore'));
    return hour === 6 ? missing ? new Response(null, { status: 204 }) : Response.json(collection)
      : Response.json(advisorySource('gairmet', hour));
  } });
  await assert.rejects(packageUpstream(advisoryResource('gairmet')), { status: 502 });
  missing = false;
  const complete = JSON.parse((await packageUpstream(advisoryResource('gairmet'))).body.toString());
  assert.equal(complete.length, 5); assert.deepEqual(complete[2], collection);
});

test('composite reads refresh aging dependencies without extending timestamps or weakening the cache TTL', async t => {
  let now = WEATHER_NOW, calls = 0;
  const resource = resourceFor('/api/weather/tafs.json?ids=KSFO');
  const cache = new WeatherCache({ directory: await directory(t), maxBytes: 1024, now: () => now,
    load: async () => { calls++; return { ...payload(), checkedAt: now }; } });
  await cache.restore(); await cache.get(resource);
  now += 59_000;
  assert.equal((await cache.get(resource)).checkedAt, WEATHER_NOW);
  const refreshed = await Promise.all([cache.get(resource, 30_000), cache.get(resource, 30_000)]);
  assert.equal(calls, 2);
  for (const result of refreshed) assert.equal(result.checkedAt, now);
  now += 20_000;
  assert.equal((await cache.get(resource, 30_000)).checkedAt, WEATHER_NOW + 59_000);
  assert.equal(calls, 2);
  now += 40_000;
  assert.equal((await cache.get(resource, 120_000)).checkedAt, now);
  assert.equal(calls, 3, 'a caller cannot extend the resource TTL');
});

test('rate limits apply across requests and malformed upstream data cannot become cache hits', async () => {
  let calls = 0;
  const upstream = createUpstream({ signal, spacing: 0, fetch: async () => { calls++; return new Response('', { status: 429, headers: { 'Retry-After': '60' } }); } });
  await assert.rejects(upstream(resourceFor(metar)), { status: 503, retryAfter: 60 });
  await assert.rejects(upstream(resourceFor(metar.replace('KSFO', 'KOAK'))), { status: 503 });
  assert.equal(calls, 1);
  for (const body of ['<html>error</html>', '{"type":"FeatureCollection","features":[],"exceededTransferLimit":true}',
    JSON.stringify({ type: 'FeatureCollection', features: Array.from({ length: 400 }, () => ({})) })]) {
    await assert.rejects(createUpstream({ signal, spacing: 0, fetch: async () => new Response(body) })(resourceFor(metar)), { status: 502 });
  }
  await assert.rejects(createUpstream({ signal, spacing: 0, fetch: async () => new Response('not an index') })(modelResource(icing + '.idx')), { status: 502 });
});
