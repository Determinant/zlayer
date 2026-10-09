import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { readGairmetCache } from '../tools/info-server/gairmet';
import { createUpstream, digest } from '../tools/info-server/upstream';
import { WeatherCache } from '../tools/info-server/cache';
import { advisoryResource, ADVISORY_MAX_AGE_MS, GAIRMET_SOURCE, resourceFor } from '../tools/info-server/routes';
import { createInfoServer } from '../tools/info-server/server';
import { createAdvisoryWarming } from '../tools/info-server/advisories';
import { normalizeAdvisories, type SourceCollection, type SourceFeature } from '../src/layers/weather-awc/source';
import { gairmetResponse, gairmetXml } from './fixtures/gairmet-cache';
import { advisorySource, advisorySnapshot, WEATHER_NOW } from './fixtures/awc-advisories';

const fixture = new URL('./fixtures/gairmet-bulk-2026-10-09/', import.meta.url);
const frames = (base = WEATHER_NOW) => [0, 3, 6, 9, 12].map(hour => advisorySource('gairmet', hour, base));
test('the captured complete bulk feed preserves all 149 AWC GeoJSON records, including closed freezing contours', async () => {
  const actual = await readGairmetCache(await readFile(new URL('gairmets.xml.gz', fixture)));
  const reference: SourceCollection[] = JSON.parse(gunzipSync(await readFile(new URL('reference.json.gz', fixture))).toString());
  const key = (feature: unknown) => {
    const f = feature as SourceFeature, properties = { ...f.properties };
    delete properties.sourceXml; delete properties.expireTime;
    return JSON.stringify([Object.entries(properties).sort(), f.geometry]);
  };
  assert.equal(actual.flatMap(c => c.features).length, 149);
  assert.deepEqual(actual.flatMap(c => c.features).map(key).sort(), reference.flatMap(c => c.features).map(key).sort());
  const snapshot = normalizeAdvisories('gairmet', actual, Date.parse('2026-10-09T22:13:29Z'), GAIRMET_SOURCE);
  assert.equal(snapshot.advisories.length, 149); assert.equal(snapshot.issues, undefined);
  assert.equal(snapshot.frameTimes.length, 5);
  assert.ok(snapshot.advisories.every(a => a.sourceProperties.sourceXml && a.sourceProperties.expireTime));
  assert.ok(JSON.stringify(snapshot).length * 2 < 4 * 1024 * 1024, 'fits the existing browser snapshot storage bound');
});

test('gzip/XML envelope, counts, times and package bounds reject incomplete or unsafe replacements', async () => {
  const xml = gairmetXml(frames());
  const cases = [xml.slice(0, -12), '<!DOCTYPE response [<!ENTITY x "expanded">]>' + xml,
    xml.replace('<errors/>', '<errors><error>partial</error></errors>'),
    xml.replace('<warnings/>', '<warnings><warning>truncated</warning></warnings>'),
    xml.replace('num_results="10"', 'num_results="11"'),
    xml.replace('num_points="5"', 'num_points="4"'),
    xml.replace('num_points="5"', 'num_points="10001"'),
    xml.replace('<valid_time>', '<valid_time>bad'),
    xml.replace('>12</roughly_', '>11</roughly_'),
    xml.replace('<tag>ICE-0</tag>', '<tag>ICE-0</tag><tag>duplicate</tag>'),
    xml.replace('<data ', '<unknown/><data ').replace('<GAIRMET>', '<unknown>'),
    xml.replace('<product>ZULU</product>', '<product>' + '<nested>'.repeat(13) + 'ZULU' + '</nested>'.repeat(13) + '</product>')];
  for (const value of cases) await assert.rejects(readGairmetCache(gzipSync(value)));
  await assert.rejects(readGairmetCache(Buffer.from('not gzip')));
  await assert.rejects(readGairmetCache(gzipSync(xml).subarray(0, 20)));
  await assert.rejects(readGairmetCache(gzipSync(' '.repeat(8 * 1024 * 1024 + 1))));
  const empty = await readGairmetCache(gzipSync(gairmetXml(Array.from({ length: 5 }, () => ({ type: 'FeatureCollection', features: [] })))));
  assert.equal(empty.length, 5); assert.ok(empty.every(c => c.features.length === 0));
  const unknownGeometry = await readGairmetCache(gzipSync(xml.replace('<geometry_type>AREA</geometry_type>', '<geometry_type>UNKNOWN</geometry_type>')));
  const partial = normalizeAdvisories('gairmet', unknownGeometry, WEATHER_NOW, GAIRMET_SOURCE);
  assert.equal(partial.schemaVersion, 2); assert.equal(partial.advisories.length, 9); assert.equal(partial.issues?.length, 1);
  assert.match(partial.issues![0]!.sourceFeature, /sourceXml/);
});

test('bulk acquisition makes one request and cannot freshen a stale, future or undated CDN publication', async () => {
  let modified: number | undefined = WEATHER_NOW - 90_000, calls = 0;
  const upstream = createUpstream({ signal: new AbortController().signal, spacing: 0, now: () => WEATHER_NOW,
    fetch: async url => {
      calls++; assert.equal(String(url), GAIRMET_SOURCE);
      const response = gairmetResponse(frames(), modified);
      if (modified === undefined) response.headers.delete('last-modified');
      return response;
    } });
  const result = await upstream(advisoryResource('gairmet'));
  assert.equal(calls, 1); assert.equal(result.checkedAt, modified);
  for (modified of [WEATHER_NOW - ADVISORY_MAX_AGE_MS, WEATHER_NOW + 31_000, undefined]) {
    await assert.rejects(upstream(advisoryResource('gairmet')), { status: 502 });
  }
});

test('outage, repeated readers, restart, expiry and recovery preserve the last complete G-AIRMET source time', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gairmet-recovery-'));
  let now = WEATHER_NOW, failing = false, calls = 0, modified = now, base = WEATHER_NOW;
  const options = { directory, startUpdates: false, spacing: 0, now: () => now, fetch: async () => {
    calls++;
    return failing ? new Response(null, { status: 504 }) : gairmetResponse(frames(base), modified);
  } };
  let app = await createInfoServer(options);
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const listen = async () => {
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address(); assert.ok(address && typeof address === 'object');
    return `http://127.0.0.1:${address.port}`;
  };
  let origin = await listen();
  const path = '/api/weather/advisories/gairmet.json', resource = resourceFor(path);
  const health = async () => (await (await fetch(origin + '/api/weather/healthz')).json()) as any;
  const original = await (await fetch(origin + path)).json(); assert.equal(calls, 1);
  failing = true; now += 61_000;
  await assert.rejects(app.cache.get(resource, 0), { status: 502 });
  const state = await health();
  assert.equal(state.advisories.gairmet.ready, true); assert.equal(state.advisories.gairmet.error, 'upstream-unavailable');
  assert.ok(state.readiness.problems.some((p: any) => p.product === 'advisory.gairmet'), 'retention must not mask failed acquisition');
  const before = calls;
  for (let count = 0; count < 3; count++) {
    const response = await fetch(origin + path); assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), original); assert.equal(response.headers.get('x-weather-checked-at'), String(WEATHER_NOW));
  }
  assert.equal(calls, before, 'readers do not amplify acquisition during a retained-data outage');
  await app.close(); app = await createInfoServer(options); origin = await listen();
  assert.deepEqual(await (await fetch(origin + path)).json(), original); assert.equal(calls, before);
  now = WEATHER_NOW + ADVISORY_MAX_AGE_MS;
  const expired = await fetch(origin + path); assert.equal(expired.status, 502); await expired.arrayBuffer();
  assert.equal((await health()).advisories.gairmet.ready, false);
  failing = false; now += 31_000; modified = now;
  const recovered = await fetch(origin + path); assert.equal(recovered.status, 200);
  assert.equal((await recovered.json() as any).checkedAt, now);
  assert.equal((await health()).advisories.gairmet.error, null);
  now += 61_000; modified = now - 120_000;
  await assert.rejects(app.cache.get(resource, 0), /regressed/);
  assert.equal((await health()).advisories.gairmet.error, 'stale-source');
  now += 31_000; modified = now; base -= 6 * 3_600_000;
  await assert.rejects(app.cache.get(resource, 0), /regressed/);
});

test('background acquisition is minute-paced, coalesces failures, and stops on shutdown', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gairmet-cadence-')), shutdown = new AbortController();
  let now = WEATHER_NOW, calls = 0, fail = false;
  const app = await createInfoServer({ directory, startUpdates: false, spacing: 0, now: () => now, fetch: async url => {
    if (String(url) === GAIRMET_SOURCE) { calls++; return fail ? new Response(null, { status: 504 }) : gairmetResponse(frames(), now); }
    return Response.json(advisorySource(String(url).includes('cwa') ? 'cwa' : 'sigmet'));
  } });
  const warming = createAdvisoryWarming(app.cache, shutdown.signal, { now: () => now });
  t.after(async () => { shutdown.abort(); await warming.close(); await app.close(); await rm(directory, { recursive: true, force: true }); });
  warming.refresh(); warming.refresh(); await warming.close(); assert.equal(calls, 1);
  now += 30_000; warming.refresh(); await warming.close(); assert.equal(calls, 1);
  now += 30_000; fail = true; warming.refresh(); warming.refresh(); await warming.close(); assert.equal(calls, 2);
  now += 29_000; warming.refresh(); await warming.close(); assert.equal(calls, 2);
  now += 1000; fail = false; warming.refresh(); await warming.close(); assert.equal(calls, 3);
  assert.equal(warming.status.gairmet!.error, null);
  shutdown.abort(); now += 60_000; warming.refresh(); await warming.close(); assert.equal(calls, 3);
});

test('upgrade immediately refreshes a legacy source and protects its publication through expiry and full-cache pressure', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gairmet-upgrade-')), shutdown = new AbortController();
  let now = WEATHER_NOW, calls = 0, started!: () => void, release!: () => void;
  const begun = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const resource = resourceFor('/api/weather/advisories/gairmet.json');
  const make = (value: unknown, checkedAt: number) => {
    const body = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    return { body, checkedAt, sha256: digest(body), status: 200, headers: { 'content-type': 'application/json' } };
  };
  const old = make(advisorySnapshot('gairmet'), now);
  let cache = new WeatherCache({ directory, maxBytes: 64 * 1024, now: () => now, load: async () => { throw new Error('seed cannot fetch'); } });
  await cache.restore(); await cache.put({ ...resource, ttl: 60_000 }, old); await cache.drain();
  now += 50_000;
  cache = new WeatherCache({ directory, maxBytes: 64 * 1024, now: () => now, signal: shutdown.signal, load: async target => {
    const product = target.url.includes('gairmet') ? 'gairmet' : target.url.includes('sigmet') ? 'sigmet' : 'cwa';
    if (product === 'gairmet') { calls++; started(); await held; }
    return make({ ...advisorySnapshot(product), checkedAt: now, ...(product === 'gairmet' ? { source: GAIRMET_SOURCE } : {}) }, now);
  } });
  const warming = createAdvisoryWarming(cache, shutdown.signal, { now: () => now });
  t.after(async () => { release(); shutdown.abort(); await warming.close(); await cache.drain(); await rm(directory, { recursive: true, force: true }); });
  await cache.restore(); await warming.restore(); await cache.prune();
  warming.refresh(); await begun;
  assert.equal(calls, 1, 'legacy identity forces acquisition even though its cached age is below one minute');
  now += 61_000;
  for (let index = 0; index < 4; index++) {
    const raw = { ...advisoryResource('cwa'), key: `pressure-${index}` };
    await cache.put(raw, make('x'.repeat(20_000), now));
  }
  assert.ok(cache.stats.capacityEvictions > 0, 'the test actually reaches capacity eviction');
  assert.equal(warming.status.gairmet!.ready, true);
  assert.deepEqual((await cache.read(resource))?.body, old.body, 'legacy expiry and unrelated raw fills cannot remove the published package');
  release(); await warming.close();
  const current = JSON.parse((await cache.read(resource))!.body.toString());
  assert.equal(current.source, GAIRMET_SOURCE); assert.equal(current.checkedAt, now);
});
