import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { isAwcAdvisorySnapshot } from '@zlayer/contracts';
import { advisoryFrame } from '../src/layers/weather-awc/time';
import { readGairmetCache } from '../tools/info-server/gairmet';
import { createUpstream, digest } from '../tools/info-server/upstream';
import { WeatherCache } from '../tools/info-server/cache';
import { advisoryResource, ADVISORY_MAX_AGE_MS, GAIRMET_SOURCE, resourceFor } from '../tools/info-server/weather-resources';
import { createInfoServer } from '../tools/info-server/server';
import { createAdvisoryWarming } from '../tools/info-server/advisories';
import { normalizeAdvisories, legacyAdvisories, type SourceCollection, type SourceFeature } from '../src/layers/weather-awc/source';
import { gairmetResponse, gairmetXml } from './fixtures/gairmet-cache';
import { advisorySource, advisorySnapshot, WEATHER_NOW } from './fixtures/awc-advisories';
import crossing from './fixtures/gairmet-crossing-2026-10-21.json' with { type: 'json' };

const fixture = new URL('./fixtures/gairmet-bulk-2026-10-09/', import.meta.url);
const frames = (base = WEATHER_NOW) => [0, 3, 6, 9, 12].map(hour => advisorySource('gairmet', hour, base));
test('G-AIRMET XML accepts equivalent finite coordinate spellings and preserves their source text', async () => {
  const xml = gairmetXml(frames()), baseline = await readGairmetCache(gzipSync(xml));
  const formats = [
    (number: number) => number.toExponential(8),
    (number: number) => (number >= 0 ? '+' : '') + number.toFixed(8),
    (number: number) => Number.isInteger(number) ? number + '.' : String(number),
  ];
  for (const format of formats) {
    const changed = xml.replace(/<(longitude|latitude)>([^<]+)<\//g, (_, name: string, value: string) => `<${name}>${format(Number(value))}</`);
    const result = await readGairmetCache(gzipSync(changed));
    const geometries = (collections: SourceCollection[]) => collections.flatMap(c => c.features).map(f => (f as SourceFeature).geometry);
    assert.deepEqual(geometries(result), geometries(baseline));
    assert.match(JSON.stringify(result), new RegExp(format(-124).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(normalizeAdvisories('gairmet', result, WEATHER_NOW, GAIRMET_SOURCE, true).issues, undefined);
  }
  const fractional = xml.replace('<longitude>-124</longitude>', '<longitude>-.5</longitude>');
  assert.match(JSON.stringify(await readGairmetCache(gzipSync(fractional))), /-0\.5/);
  for (const value of ['NaN', 'INF', '1e999', '0x10', '1_000', '1e', '1 2']) {
    const changed = xml.replace(/<longitude>[^<]+<\/longitude>/, `<longitude>${value}</longitude>`);
    const result = normalizeAdvisories('gairmet', await readGairmetCache(gzipSync(changed)), WEATHER_NOW, GAIRMET_SOURCE, true);
    assert.equal(result.advisories.length, 9); assert.equal(result.issues?.length, 1);
    assert.match(result.issues![0]!.sourceFeature, /invalid coordinate number/);
  }
});

test('captured XML crossing publishes neighbors, retains its rule through restart and clears on source replacement', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gairmet-crossing-'));
  let now = crossing.checkedAt, includeCrossing = true, calls = 0;
  const base = Date.parse(crossing.feature.properties.validTime);
  type Xml = { name: string; attributes: Record<string, string>; text: string; children: Xml[] };
  const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const xml = (node: Xml): string => `<${node.name}${Object.entries(node.attributes).map(([k, v]) => ` ${k}="${escape(v)}"`).join('')}>` +
    escape(node.text) + node.children.map(xml).join('') + `</${node.name}>`;
  const options = { directory, startUpdates: false, spacing: 0, now: () => now, fetch: async () => {
    calls++;
    let body = gairmetXml(frames(base));
    if (includeCrossing) body = body.replace('num_results="10"', 'num_results="11"').replace('</data>', xml(crossing.feature.properties.sourceXml as Xml) + '</data>');
    return new Response(Uint8Array.from(gzipSync(body)), { headers: { 'last-modified': new Date(now).toUTCString() } });
  } };
  let app = await createInfoServer(options);
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const listen = async () => {
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address(); assert.ok(address && typeof address === 'object'); return `http://127.0.0.1:${address.port}`;
  };
  let origin = await listen();
  const path = '/api/weather/advisories/gairmet-v3.json';
  const snapshot = await (await fetch(origin + path)).json();
  assert.equal(snapshot.advisories.length, 10); assert.equal(snapshot.issues.length, 1);
  const rule = 'Unsupported advisory ring topology: crossing edges 5 and 7';
  assert.equal(snapshot.issues[0].geometryError, rule);
  assert.deepEqual(JSON.parse(snapshot.issues[0].sourceFeature), crossing.feature);
  const before = await (await fetch(origin + '/api/weather/healthz')).json();
  assert.equal(before.advisories.gairmet.error, 'incomplete-advisories');
  assert.equal(before.advisories.gairmet.interpretation.issueSamples[0].rule, rule);
  assert.equal(before.advisories.gairmet.errorDetail, `1 unresolved; example TANGO 2W: ${rule}`);
  const page = await (await fetch(origin + '/api/weather/healthz', { headers: { Accept: 'text/html' } })).text();
  assert.match(page, /TANGO 2W: Unsupported advisory ring topology: crossing edges 5 and 7/);
  assert.match(before.advisories.gairmet.evidenceId, /^[a-f0-9]{64}$/);
  await app.close(); app = await createInfoServer(options); origin = await listen();
  const restored = await (await fetch(origin + '/api/weather/healthz')).json();
  assert.equal(calls, 1); assert.equal(restored.advisories.gairmet.checkedAt, snapshot.checkedAt);
  assert.deepEqual(restored.advisories.gairmet.interpretation, before.advisories.gairmet.interpretation);
  assert.equal(restored.advisories.gairmet.errorDetail, before.advisories.gairmet.errorDetail);
  includeCrossing = false; now += 61_000;
  await app.cache.get(resourceFor(path), 0);
  const recovered = await (await fetch(origin + '/api/weather/healthz')).json();
  assert.equal(recovered.advisories.gairmet.error, null);
  assert.equal(recovered.advisories.gairmet.errorDetail, null);
  assert.equal(recovered.advisories.gairmet.unresolvedRecords, 0);
  assert.deepEqual(recovered.advisories.gairmet.interpretation.issueSamples, []);
});

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
    xml.replace('<data ', '<unknown/><data ').replace('<GAIRMET>', '<unknown>'),
    xml.replace('<product>ZULU</product>', '<product>' + '<nested>'.repeat(13) + 'ZULU' + '</nested>'.repeat(13) + '</product>')];
  for (const value of cases) await assert.rejects(readGairmetCache(gzipSync(value)));
  const memberCases = [
    xml.replace('num_points="5"', 'num_points="4"'),
    xml.replace('num_points="5"', 'num_points="10001"'),
    xml.replace('<valid_time>', '<valid_time>bad'),
    xml.replace('>12</roughly_', '>11</roughly_'),
    xml.replace('<tag>ICE-0</tag>', '<tag>ICE-0</tag><tag>duplicate</tag>')
  ];
  for (const value of memberCases) {
    const partial = normalizeAdvisories('gairmet', await readGairmetCache(gzipSync(value)), WEATHER_NOW, GAIRMET_SOURCE, true);
    assert.ok(isAwcAdvisorySnapshot(partial));
    assert.equal(partial.advisories.length + partial.issues!.length, 10);
    assert.match(partial.issues![0]!.sourceFeature, /adaptationError/);
  }
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


test('independent captured cycles retain every original lead, validity and product through v3 and explicit legacy projection', async () => {
  const body = await readFile(new URL('./fixtures/gairmet-cycle-overlap-2026-10-21/gairmets.xml.gz', import.meta.url));
  const checkedAt = Date.parse('2026-10-21T02:50:31Z');
  const collections = await readGairmetCache(body);
  const snapshot = normalizeAdvisories('gairmet', collections, checkedAt, GAIRMET_SOURCE, true);
  assert.ok(isAwcAdvisorySnapshot(snapshot)); assert.equal(snapshot.schemaVersion, 3);
  assert.equal(snapshot.advisories.length, 161); assert.equal(snapshot.issues, undefined);
  assert.deepEqual(snapshot.cycleTimes, [Date.parse('2026-10-20T21:00Z'), Date.parse('2026-10-21T03:00Z')]);
  assert.equal(snapshot.frameTimes.length, 7);
  assert.equal(snapshot.advisories.filter(a => a.issuer === 'SIERRA').length, 18);
  for (const advisory of snapshot.advisories) {
    assert.equal(advisory.forecastHour, advisory.sourceProperties.forecast);
    assert.equal(advisory.validFrom, Date.parse(advisory.sourceProperties.validTime as string));
  }
  const shared = Date.parse('2026-10-21T03:00Z');
  const frame = advisoryFrame(snapshot, shared);
  assert.ok(frame.advisories.some(a => a.issuer === 'SIERRA' && a.forecastHour === 6));
  assert.ok(frame.advisories.some(a => a.issuer !== 'SIERRA' && a.forecastHour === 0));
  const legacy = legacyAdvisories(snapshot);
  assert.ok(isAwcAdvisorySnapshot(legacy)); assert.equal(legacy.schemaVersion, 2);
  assert.equal(legacy.advisories.length, 143); assert.equal(legacy.issues?.length, 18);
  assert.ok(legacy.issues!.every(issue => issue.sourceFeature.includes('sourceXml')));
  assert.ok(!isAwcAdvisorySnapshot({ ...snapshot, schemaVersion: 1 }));
  assert.ok(!isAwcAdvisorySnapshot({ ...snapshot, cycleTimes: snapshot.cycleTimes!.slice().reverse() }));
  assert.ok(!isAwcAdvisorySnapshot({ ...snapshot, frameTimes: snapshot.frameTimes.slice(1) }));
});

test('explicit bulk counts permit 400 records in one frame while query responses retain their truncation guard', async () => {
  const record = advisorySource('gairmet', 0).features[0] as SourceFeature;
  const collections: SourceCollection[] = Array.from({ length: 5 }, () => ({ type: 'FeatureCollection', features: [] }));
  collections[0]!.features = Array.from({ length: 400 }, (_, i) => ({ ...record, properties: { ...record.properties, tag: `bulk-${i}` } }));
  const adapted = await readGairmetCache(gzipSync(gairmetXml(collections)));
  assert.equal(normalizeAdvisories('gairmet', adapted, WEATHER_NOW, GAIRMET_SOURCE, true).advisories.length, 400);
  assert.throws(() => normalizeAdvisories('gairmet', adapted, WEATHER_NOW, GAIRMET_SOURCE), /incomplete/);
  await assert.rejects(readGairmetCache(gzipSync(gairmetXml(collections).replace('num_results="400"', 'num_results="2001"'))), /2000/);
});

test('v3 and legacy routes share one acquisition and restore without refetching or rewriting source time', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gairmet-v3-'));
  const body = await readFile(new URL('./fixtures/gairmet-cycle-overlap-2026-10-21/gairmets.xml.gz', import.meta.url));
  const now = Date.parse('2026-10-21T02:50:51Z'); let calls = 0;
  const options = { directory, startUpdates: false, spacing: 0, now: () => now, fetch: async () => {
    calls++; return new Response(Uint8Array.from(body), { headers: { 'last-modified': 'Wed, 21 Oct 2026 02:50:31 GMT' } });
  } };
  let app = await createInfoServer(options);
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const canonical = resourceFor('/api/weather/advisories/gairmet-v3.json'), legacy = resourceFor('/api/weather/advisories/gairmet.json');
  const full = JSON.parse((await app.cache.get(canonical)).body.toString());
  const older = JSON.parse((await app.cache.get(legacy)).body.toString());
  assert.equal(full.schemaVersion, 3); assert.equal(older.schemaVersion, 2); assert.equal(calls, 1);
  await app.close(); app = await createInfoServer(options);
  assert.deepEqual(JSON.parse((await app.cache.get(canonical)).body.toString()), full);
  assert.deepEqual(JSON.parse((await app.cache.get(legacy)).body.toString()), older); assert.equal(calls, 1);
});


test('v3 selection follows each cycle independently instead of discarding another cycle between its native stops', () => {
  const inputs = frames();
  for (const [i, collection] of inputs.entries()) collection.features.push(...advisorySource('gairmet', [0, 3, 6, 9, 12][i]!, WEATHER_NOW + 3600_000).features);
  const snapshot = normalizeAdvisories('gairmet', inputs, WEATHER_NOW + 3600_000, GAIRMET_SOURCE, true);
  const selected = advisoryFrame(snapshot, WEATHER_NOW + 4 * 3600_000);
  assert.equal(selected.advisories.length, 4);
  assert.deepEqual([...new Set(selected.advisories.map(a => a.validFrom))], [WEATHER_NOW + 3 * 3600_000, WEATHER_NOW + 4 * 3600_000]);
  assert.equal(advisoryFrame(snapshot, WEATHER_NOW + 13 * 3600_000).advisories.length, 2, 'expired earlier cycle cannot borrow another cycle horizon');
});


test('cycle regression is checked per issuer while newly observed independent cycles remain admissible', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gairmet-regression-'));
  let now = WEATHER_NOW, mode = 0;
  const app = await createInfoServer({ directory, startUpdates: false, spacing: 0, now: () => now, fetch: async () => {
    const inputs = frames(mode === 2 ? WEATHER_NOW - 6 * 3600_000 : WEATHER_NOW);
    if (mode > 0) for (const [i, collection] of inputs.entries()) {
      const record = advisorySource('gairmet', [0, 3, 6, 9, 12][i]!, WEATHER_NOW - 6 * 3600_000).features[0] as SourceFeature;
      collection.features.push({ ...record, properties: { ...record.properties, product: 'SIERRA', tag: `SIERRA-${i}` } });
    }
    return gairmetResponse(inputs, now);
  } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const resource = resourceFor('/api/weather/advisories/gairmet-v3.json');
  await app.cache.get(resource); mode = 1; now += 61_000;
  const accepted = await app.cache.get(resource, 0);
  assert.equal(JSON.parse(accepted.body.toString()).schemaVersion, 3);
  mode = 2; now += 61_000;
  await assert.rejects(app.cache.get(resource, 0), /ZULU cycle regressed/);
  assert.deepEqual((await app.cache.read(resource))?.body, accepted.body);
});
