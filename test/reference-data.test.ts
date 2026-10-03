import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchJson } from '../src/core/data/fetch-json';
import { fetchAirways, fetchNavigation, fetchNavigationCollections } from '../src/layers/navigation/api';
import { fetchPreferredRoutes, fetchTerminalProcedures } from '../src/layers/routes/api';
import { referenceGuard, isReferenceResource } from '../src/core/data/references';
import { readFileSync } from 'node:fs';
import type { TerminalProceduresResource } from '@zlayer/contracts';
import { airwayDocumentGuard, preferredRoutesDocumentGuard } from '../src/core/data/references';
import type { AirwayResourceRecord, ChartRecord, NavigationLayerRecord, PreferredRoutesResource } from '@zlayer/contracts';
import { cacheFixture } from './helpers/cache';
import { captureReference } from '../src/core/data/reference-snapshot';
import { jsonIdentity } from '../src/core/data/json-identity';

const revision = '2026-09-03';

test('SID/STAR browsing and regional downloads share a validated whole-file cache and retry failed loads', async t => {
  const { stored } = cacheFixture(t);
  const data = JSON.parse(readFileSync(new URL('../packages/contracts/test/fixtures/terminal-procedures.json', import.meta.url), 'utf8'));
  const resource: TerminalProceduresResource = { id: 'terminal-procedures', title: 'SID/STAR routes',
    url: 'https://charts.test/terminal-procedures.json?v=1', count: 2, sourceCount: 2 };
  assert.ok(isReferenceResource(resource));
  let requests = 0, invalid = true;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return Response.json(invalid ? { ...data, procedures: [] } : data); });
  await assert.rejects(fetchTerminalProcedures(resource, revision), /invalid document/);
  assert.equal(stored.size, 0);
  invalid = false;
  const [first, second] = await Promise.all([fetchTerminalProcedures(resource, revision), fetchTerminalProcedures(resource, revision)]);
  assert.equal(first, second);
  assert.equal(requests, 2, 'one failed and one coalesced successful request');
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  assert.deepEqual(await fetchJson(resource.url, referenceGuard(resource, revision), 'Offline procedure routes', { requireCache: true }), data);
  assert.equal(stored.size, 1, 'one durable file is reused by browsing and regional saving');
  assert.equal(referenceGuard(resource, '2026-10-01')(data), false);
});
const source = { type: 'FeatureCollection', metadata: { effectiveDate: revision, source: 'FAA' }, features: [{
  type: 'Feature', id: 'airport:KMGM', geometry: { type: 'Point', coordinates: [-86.39, 32.3] },
  properties: { ident: 'KMGM', name: 'Montgomery' },
}] };
const layer = (id: NavigationLayerRecord['id'], suffix: string): NavigationLayerRecord => ({
  id, title: id, url: `https://charts.test/${suffix}/${id}.json`, count: 1, sourceCount: 1, minZoom: 0,
});

for (const cached of [false, true]) {
  test(`capturing ${cached ? 'cached' : 'downloaded'} JSON parses and hashes it only once`, async t => {
    const { stored, cache } = cacheFixture(t);
    const resource = layer('airports', `hash-once-${cached}`);
    const text = JSON.stringify(source), digest = jsonIdentity(source), bytes = new TextEncoder().encode(text);
    if (cached) stored.set(resource.url, new Response(text));
    t.mock.method(globalThis, 'fetch', async () => new Response(bytes));
    const parse = t.mock.method(Response.prototype, 'json');
    const match = t.mock.method(cache, 'match');
    let hashes = 0;
    const encode = TextEncoder.prototype.encode;
    t.mock.method(TextEncoder.prototype, 'encode', function (this: TextEncoder, value?: string) {
      if (value === text) hashes++;
      return encode.call(this, value);
    });
    const pinned = await captureReference(resource, revision);
    assert.equal(pinned.jsonSha256, digest);
    assert.equal(hashes, 1);
    assert.equal(parse.mock.calls.length, 1);
    assert.equal(match.mock.calls.length, 1, 'snapshot copying must not reopen the source');
    assert.equal(await stored.get(pinned.url)!.clone().text(), text);
  });
}

test('capturing a reference pins its validated bytes even if another window replaces the source', async t => {
  const { stored, cache } = cacheFixture(t);
  const resource = layer('airports', 'concurrent-replacement');
  const replacement = { ...source, metadata: { ...source.metadata, source: 'replacement' } };
  stored.set(resource.url, Response.json(source));
  const match = cache.match;
  t.mock.method(cache, 'match', async (request: RequestInfo | URL) => {
    const response = await match(request);
    stored.set(resource.url, Response.json(replacement));
    return response;
  });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('must use the captured response'); });
  const pinned = await captureReference(resource, revision);
  assert.equal(pinned.jsonSha256, jsonIdentity(source));
  assert.deepEqual(await stored.get(pinned.url)!.clone().json(), source);
  assert.deepEqual(await stored.get(resource.url)!.clone().json(), replacement);
});

test('saved navigation rejects a same-cycle, same-count replacement after eviction and keeps builds separate', async t => {
  const { stored } = cacheFixture(t);
  const airports = layer('airports', 'snapshot');
  const replacement = { ...source, features: [{ ...source.features[0], properties: { ident: 'KMGM', name: 'REPLACEMENT' } }] };
  t.mock.method(globalThis, 'fetch', async () => Response.json(source));
  const saved = await captureReference(airports, revision);
  assert.equal(saved.jsonSha256, jsonIdentity(source));
  assert.notEqual(saved.url, airports.url);
  stored.delete(saved.url);
  stored.delete(airports.url);
  t.mock.method(globalThis, 'fetch', async () => Response.json(replacement));
  // Warm the ordinary browsing memory cache before loading the saved reference.
  assert.equal((await fetchNavigation(airports, revision, [])).features[0]!.properties.name, 'REPLACEMENT');
  await assert.rejects(fetchNavigation(saved, revision, []), /invalid document/);
  assert.equal(stored.has(saved.url), false, 'replacement never becomes the saved export');
  await assert.rejects(fetchNavigation({ ...saved, url: airports.url }, revision, []), /invalid document/,
    'identity is part of memory keys even if URLs coincide');
  const next = await captureReference(airports, revision);
  assert.notEqual(next.jsonSha256, saved.jsonSha256);
  assert.notEqual(next.url, saved.url);
  t.mock.method(globalThis, 'fetch', async () => Response.json(source));
  assert.equal((await fetchNavigation(saved, revision, [])).features[0]!.properties.name, 'Montgomery');
  assert.equal((await fetchNavigation(next, revision, [])).features[0]!.properties.name, 'REPLACEMENT');
});

test('reference identity validation covers airways, preferred routes and SID/STAR exports', async t => {
  cacheFixture(t);
  const metadata = { effectiveDate: revision, source: 'FAA' };
  const terminal = JSON.parse(readFileSync(new URL('../packages/contracts/test/fixtures/terminal-procedures.json', import.meta.url), 'utf8'));
  const fixtures = [
    { id: 'airways' as const, count: 0, data: { type: 'ZLayerAirways', metadata, airways: [] } },
    { id: 'preferred-routes' as const, count: 0, data: { type: 'ZLayerPreferredRoutes', metadata, routes: [] } },
    { id: 'terminal-procedures' as const, count: 2, data: terminal },
  ];
  for (const { id, count, data } of fixtures) {
    const resource = { id, title: id, count, sourceCount: count, url: `https://charts.test/identities/${id}.json` };
    t.mock.method(globalThis, 'fetch', async () => Response.json(data));
    const saved = await captureReference(resource, revision);
    const changed = { ...data, metadata: { ...data.metadata, source: 'Same cycle replacement' } };
    assert.equal(referenceGuard(resource, revision)(changed), true, 'schema and counts alone accept this change');
    assert.equal(referenceGuard(saved, revision)(changed), false, id);
    assert.equal(isReferenceResource({ ...saved, jsonSha256: 'bad' }), false);
  }
});

test('legacy cache-only reference reads cannot download replacement exports after eviction', async t => {
  const { stored } = cacheFixture(t);
  const airports = { ...layer('airports', 'legacy-snapshot'), cacheOnly: true };
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(source));
  await assert.rejects(fetchNavigation(airports, revision, []), /Update to latest/);
  assert.equal(fetch.mock.calls.length, 0);
  stored.set(airports.url, Response.json(source));
  assert.equal((await fetchNavigation(airports, revision, [])).features.length, 1);
});

test('national and chart-clipped navigation share one raw export request', async t => {
  cacheFixture(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(source));
  const airports = layer('airports', 'shared-source');
  const [national, clipped] = await Promise.all([
    fetchNavigation(airports, revision, []),
    fetchNavigation(airports, revision, [{ bounds: [0, 0, 1, 1] } as ChartRecord]),
  ]);
  assert.equal(fetch.mock.calls.length, 1);
  assert.equal(national.features.length, 1);
  assert.equal(clipped.features.length, 0);
});

test('old product identifiers load as ZLayer documents online and from saved offline packs', async t => {
  const { stored } = cacheFixture(t);
  const airways: AirwayResourceRecord = { id: 'airways', title: 'Airways', count: 1, sourceCount: 1,
    url: 'https://charts.test/product-rename/airways.json' };
  const preferred: PreferredRoutesResource = { id: 'preferred-routes', title: 'Preferred routes', count: 1, sourceCount: 1,
    url: 'https://charts.test/product-rename/preferred-routes.json' };
  const oldAirways = { type: 'AWCPlusAirways', metadata: { effectiveDate: revision, source: 'FAA' },
    airways: [{ id: 'v55', ident: 'V55', points: ['FWA', 'GFK'],
      segments: [{ sequence: 1, from: 'FWA', to: 'GFK', gap: false }] }] };
  const oldPreferred = { type: 'AWCPlusPreferredRoutes', metadata: oldAirways.metadata,
    routes: [{ id: 'preferred-route:SBA:SMO:TEC:4', originId: 'SBA', destinationId: 'SMO',
      routeType: 'TEC', routeNumber: 4, route: 'KWANG CMA', segments: [] }] };
  t.mock.method(globalThis, 'fetch', async (url: unknown) => Response.json(
    url === airways.url ? oldAirways : oldPreferred,
  ));
  const canonicalAirways = { ...oldAirways, type: 'ZLayerAirways' };
  const canonicalPreferred = { ...oldPreferred, type: 'ZLayerPreferredRoutes' };
  assert.deepEqual(await fetchAirways(airways, revision), canonicalAirways);
  assert.deepEqual(await fetchPreferredRoutes(preferred, revision), canonicalPreferred);
  assert.equal((await stored.get(airways.url)!.clone().json()).type, oldAirways.type);
  assert.equal((await stored.get(preferred.url)!.clone().json()).type, oldPreferred.type);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  assert.deepEqual(await fetchJson(airways.url, airwayDocumentGuard(airways, revision), 'Airways'), canonicalAirways);
  assert.deepEqual(await fetchJson(preferred.url, preferredRoutesDocumentGuard(preferred, revision), 'Routes'), canonicalPreferred);
  assert.equal(stored.size, 2, 'the rename must not evict valid saved packs');

  const bad = { ...oldAirways, airways: [{ ...oldAirways.airways[0], segments: [{ sequence: 1, from: 'FWA', to: 'GFK' }] }] };
  t.mock.method(globalThis, 'fetch', async () => Response.json(bad));
  const invalid = { ...airways, url: `${airways.url}?invalid` };
  await assert.rejects(fetchAirways(invalid, revision), /invalid document/);
  assert.equal(stored.has(invalid.url), false, 'compatibility must still reject missing airway gap flags');
});

test('legacy airway caches without gap flags are rejected and replaced by a verified export', async t => {
  const { stored } = cacheFixture(t);
  const resource: AirwayResourceRecord = { id: 'airways', title: 'Airways', count: 1, sourceCount: 1,
    url: 'https://charts.test/airway-gap-migration.json' };
  const legacy = { type: 'ZLayerAirways', metadata: { effectiveDate: revision, source: 'FAA' },
    airways: [{ id: 'v55', ident: 'V55', points: ['FWA', 'GFK'],
      segments: [{ sequence: 1, from: 'FWA', to: 'GFK' }] }] };
  stored.set(resource.url, Response.json(legacy));
  t.mock.method(globalThis, 'fetch', async () => Response.json(legacy));
  await assert.rejects(fetchAirways(resource, revision), /invalid document/);
  assert.deepEqual(await stored.get(resource.url)!.clone().json(), legacy,
    'invalid bytes stay untouched until a validated replacement is ready');
  const corrected = { ...legacy, airways: [{ ...legacy.airways[0],
    segments: [{ ...legacy.airways[0]!.segments[0], gap: true }] }] };
  t.mock.method(globalThis, 'fetch', async () => Response.json(corrected));
  assert.deepEqual(await fetchAirways(resource, revision), corrected);
  assert.deepEqual(await stored.get(resource.url)!.clone().json(), corrected);
});

test('invalid cached navigation recovers in one network request and reuses its verified file offline', async t => {
  const { stored } = cacheFixture(t);
  const airports = layer('airports', 'recover');
  stored.set(airports.url, Response.json({ broken: true }));
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options?: RequestInit) => {
    requests++;
    assert.equal(options?.cache, 'no-store');
    assert.ok(options?.signal);
    return Response.json(source);
  });
  assert.equal((await fetchNavigation(airports, revision, [])).features.length, 1);
  assert.equal(requests, 1);
  assert.deepEqual(await stored.get(airports.url)!.clone().json(), source);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  assert.equal((await fetchNavigation({ ...airports, id: 'fixes' }, revision, [])).features.length, 1);
});

test('JSON syntax, schema, and manifest count failures never become durable responses', async t => {
  const { stored } = cacheFixture(t);
  const airports = layer('airports', 'invalid');
  for (const response of [new Response('{'), Response.json({ wrong: true }), Response.json({ ...source, features: [] })]) {
    t.mock.method(globalThis, 'fetch', async () => response.clone());
    await assert.rejects(fetchNavigation(airports, revision, []), /invalid/);
    assert.equal(stored.has(airports.url), false);
  }
  t.mock.method(globalThis, 'fetch', async () => Response.json(source));
  assert.equal((await fetchNavigation(airports, revision, [])).features.length, 1);
});

test('a failed fixes feed preserves healthy airport search data', async t => {
  cacheFixture(t);
  t.mock.method(globalThis, 'fetch', async (url: unknown) => String(url).includes('/fixes.')
    ? new Response(null, { status: 503 }) : Response.json(source));
  const result = await fetchNavigationCollections([layer('airports', 'partial'), layer('fixes', 'partial')], revision, []);
  assert.deepEqual(result.unavailable, ['fixes']);
  assert.equal(result.collections[0]?.features[0]?.properties.ident, 'KMGM');
});

for (const policy of ['cache-first', 'network-first', 'network-only', 'cache-only'] as const) {
  test(`JSON ${policy} preserves source preference and offline fallback`, async t => {
    const { stored } = cacheFixture(t);
    const url = 'https://charts.test/read-policy.json';
    const guard = (value: unknown): value is string => value === 'saved' || value === 'fresh';
    const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json('fresh'));
    stored.set(url, Response.json('saved'));
    const network = policy === 'network-first' || policy === 'network-only';
    assert.equal(await fetchJson(url, guard, 'Reference', { policy }), network ? 'fresh' : 'saved');
    assert.equal(fetch.mock.callCount(), network ? 1 : 0);
    stored.set(url, Response.json('saved'));
    fetch.mock.mockImplementation(async () => { throw new Error('offline'); });
    const fallback = fetchJson(url, guard, 'Reference', { policy });
    if (policy === 'network-only') await assert.rejects(fallback, /offline/);
    else assert.equal(await fallback, 'saved');
    assert.equal(fetch.mock.callCount(), network ? 2 : 0);
    stored.delete(url);
    const missing = fetchJson(url, guard, 'Reference', { policy });
    await assert.rejects(missing, policy === 'cache-only' ? /no saved export identity/ : /offline/);
    assert.equal(fetch.mock.callCount(), policy === 'cache-only' ? 0 : network ? 3 : 1);
  });
}

test('revalidation preserves a valid offline fallback, but respects explicit cancellation', async t => {
  const { stored } = cacheFixture(t);
  const url = 'https://charts.test/manifest.json';
  const guard = (value: unknown): value is { ready: true } => !!value && (value as { ready?: boolean }).ready === true;
  stored.set(url, Response.json({ ready: true }));
  t.mock.method(globalThis, 'fetch', async () => Response.json({ bad: true }));
  assert.deepEqual(await fetchJson(url, guard, 'Manifest', { policy: 'network-first' }), { ready: true });
  assert.deepEqual(await stored.get(url)!.clone().json(), { ready: true });
  const signal = AbortSignal.abort();
  t.mock.method(globalThis, 'fetch', async () => { signal.throwIfAborted(); return Response.json({}); });
  await assert.rejects(fetchJson(url, guard, 'Manifest', { policy: 'network-first', signal }), { name: 'AbortError' });
});

test('ordinary browsing tolerates denied storage, but explicit offline downloads do not', async t => {
  const { cache } = cacheFixture(t);
  const guard = (value: unknown): value is number => value === 1;
  t.mock.method(globalThis, 'fetch', async () => Response.json(1));
  t.mock.method(cache, 'put', async () => { throw new Error('quota'); });
  assert.equal(await fetchJson('https://charts.test/data', guard, 'Reference'), 1);
  await assert.rejects(fetchJson('https://charts.test/data', guard, 'Reference', { requireCache: true }), /quota/);
});


const referenceUrl = 'https://charts.test/storage-recovery.json';
const referenceGuardOne = (value: unknown): value is number => value === 1;
function referenceGate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

for (const operation of ['open', 'match', 'body', 'gzip-body', 'put'] as const) {
  for (const cancel of [false, true]) test(`reference ${operation} stall permits ${cancel ? 'cancellation' : 'network recovery'}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { cache } = cacheFixture(t), entered = referenceGate();
    const blocked = async () => { entered.resolve(); return new Promise<never>(() => {}); };
    let bodyCancelled = false;
    if (operation === 'open') t.mock.method(caches, 'open', blocked);
    if (operation === 'match') t.mock.method(cache, 'match', blocked);
    if (operation === 'body' || operation === 'gzip-body') t.mock.method(cache, 'match', async () =>
      new Response(new ReadableStream({ pull: blocked, cancel() { bodyCancelled = true; } }, { highWaterMark: 0 })));
    if (operation === 'put') t.mock.method(cache, 'put', blocked);
    const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(1));
    const controller = new AbortController();
    const result = fetchJson(referenceUrl, referenceGuardOne, 'Reference', { signal: controller.signal,
      ...(operation === 'gzip-body' ? { gzip: { bytes: 10, uncompressedBytes: 1 } } : {}) });
    const outcome = cancel ? assert.rejects(result, { name: 'AbortError' }) : result;
    await entered.promise;
    if (cancel) controller.abort();
    else t.mock.timers.tick(10_000);
    assert.equal(await outcome, cancel ? undefined : 1);
    assert.equal(fetch.mock.callCount(), cancel && operation !== 'put' ? 0 : 1);
    if (operation === 'body' || operation === 'gzip-body') {
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.ok(bodyCancelled, 'timed-out or cancelled consumption releases the cached producer');
    }
  });
}

test('reference network-only refresh skips cached body inspection', async t => {
  const { cache } = cacheFixture(t);
  const match = t.mock.method(cache, 'match', async () => { throw new Error('Must not read old bytes'); });
  t.mock.method(globalThis, 'fetch', async () => Response.json(1));
  assert.equal(await fetchJson(referenceUrl, referenceGuardOne, 'Reference', { policy: 'network-only' }), 1);
  assert.equal(match.mock.callCount(), 0);
});

test('access bookkeeping cannot delay a validated reference read', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  cacheFixture(t);
  const opened = referenceGate();
  const connection = {} as IDBOpenDBRequest;
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: {
    open() { opened.resolve(); return connection; },
  } });
  t.after(() => Reflect.deleteProperty(globalThis, 'indexedDB'));
  t.mock.method(globalThis, 'fetch', async () => Response.json(1));
  const result = fetchJson('https://charts.test/bookkeeping.json', referenceGuardOne, 'Reference');
  await opened.promise;
  assert.equal(await result, 1);
  connection.onerror!(new Event('error'));
});

test('a cancelled cache match disposes its late response without pinning it', async t => {
  const { cache, stored } = cacheFixture(t), entered = referenceGate(), finish = referenceGate();
  let discarded = false;
  t.mock.method(cache, 'match', async () => {
    entered.resolve(); await finish.promise;
    return new Response(new ReadableStream({ cancel() { discarded = true; } }));
  });
  const controller = new AbortController();
  const result = assert.rejects(fetchJson(referenceUrl, referenceGuardOne, 'Reference', {
    signal: controller.signal, cacheAs: () => 'https://charts.test/pinned',
  }), { name: 'AbortError' });
  await entered.promise; controller.abort(); await result;
  finish.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(discarded); assert.equal(stored.size, 0);
});

test('explicit reference saves do not succeed before their cache write completes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { cache, stored } = cacheFixture(t), entered = referenceGate(), finish = referenceGate();
  const put = cache.put;
  t.mock.method(cache, 'put', async (key: RequestInfo | URL, response: Response) => {
    entered.resolve(); await finish.promise; return put(key, response);
  });
  t.mock.method(globalThis, 'fetch', async () => Response.json(1));
  let completed = false;
  const result = fetchJson(referenceUrl, referenceGuardOne, 'Reference', { requireCache: true })
    .then(value => { completed = true; return value; });
  await entered.promise; t.mock.timers.tick(10_000);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(completed, false); assert.equal(stored.size, 0);
  finish.resolve(); assert.equal(await result, 1); assert.ok(stored.has(referenceUrl));
});

test('a stale invalid-reference inspection cannot delete another window’s successful repair', async t => {
  const { stored } = cacheFixture(t);
  stored.set(referenceUrl, Response.json('corrupt'));
  const guard = (value: unknown): value is number => {
    if (value === 'corrupt') stored.set(referenceUrl, Response.json(1));
    return value === 1;
  };
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  await assert.rejects(fetchJson(referenceUrl, guard, 'Reference'), /offline/);
  assert.equal(await fetchJson(referenceUrl, guard, 'Reference', { policy: 'cache-only' }), 1);
});
