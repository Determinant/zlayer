import { draftSnapshot } from './helpers/route-draft';
import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import type { GeoPointFeature } from '@zlayer/contracts';
import { createRouteHistoryStore } from '../src/layers/routes/history/store';
import { parseGzipJson } from '../src/core/data/gzip-json';
import { filedRouteDraft, routeHistoryQuery } from '../src/layers/routes/history/draft';
import { history, resource as metadata, revision } from './helpers/route-history';
import { cacheFixture } from './helpers/cache';
import { isRouteHistoryData } from '@zlayer/contracts';

const json = JSON.stringify(history);
const bytes = new Uint8Array(gzipSync(json));
const resource = { ...metadata, bytes: bytes.length, uncompressedBytes: Buffer.byteLength(json) };
const query = { origins: ['KSBA', 'SBA'], destinations: ['KSMO', 'SMO'] };

test('saved history validates the actual export even when source receipts, sizes and totals are unchanged', async t => {
  const { stored } = cacheFixture(t);
  t.mock.method(globalThis, 'fetch', async () => new Response(bytes));
  const saved = await createRouteHistoryStore().prepare(resource, revision);
  assert.match(saved.jsonSha256!, /^[a-f0-9]{64}$/);
  assert.deepEqual(new Uint8Array(await stored.get(saved.url)!.clone().arrayBuffer()), bytes, 'saved copies stay compressed');
  stored.delete(saved.url);
  const replacement = structuredClone(history);
  const route = replacement.pairs[0]!.routes[0]!;
  route.route = `X${route.route.slice(1)}`;
  assert.equal(isRouteHistoryData(replacement, revision, resource), true);
  assert.equal(JSON.stringify(replacement).length, json.length);
  t.mock.method(globalThis, 'fetch', async () => Response.json(replacement));
  await assert.rejects(createRouteHistoryStore().query(saved, revision, query), /invalid document/);
  assert.equal(stored.has(saved.url), false);
});

test('capturing gzip history decompresses its response once and preserves the original compressed bytes', async t => {
  const { stored } = cacheFixture(t);
  const Original = globalThis.DecompressionStream;
  let decompressions = 0;
  globalThis.DecompressionStream = class extends Original {
    constructor(format: CompressionFormat) { super(format); decompressions++; }
  };
  t.after(() => { globalThis.DecompressionStream = Original; });
  t.mock.method(globalThis, 'fetch', async () => new Response(bytes));
  const pinned = await createRouteHistoryStore().prepare(resource, revision);
  assert.equal(decompressions, 1);
  assert.deepEqual(new Uint8Array(await stored.get(pinned.url)!.clone().arrayBuffer()), bytes);
});

test('gzip loading saves one compressed snapshot and works in a fresh offline reader', async t => {
  const { stored } = cacheFixture(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(bytes));
  const store = createRouteHistoryStore();
  const [all, piston] = await Promise.all([
    store.query(resource, revision, query), store.query(resource, revision, { ...query, engine: 'Piston' }),
  ]);
  assert.equal(all.totalCount, 17);
  assert.equal(piston.totalCount, 13);
  assert.equal(fetch.mock.calls.length, 1);
  assert.deepEqual(new Uint8Array(await stored.get(resource.url)!.clone().arrayBuffer()), bytes);
  fetch.mock.mockImplementation(async () => { throw new Error('Offline'); });
  const offline = createRouteHistoryStore();
  assert.equal(await offline.cached(resource, revision), true);
  assert.deepEqual(await offline.query(resource, revision, query), all);
  await offline.prepare(resource, revision);
  assert.equal(fetch.mock.calls.length, 1, 'valid saved data needs no network');
  stored.clear();
  assert.equal(await offline.cached(resource, revision), false, 'memory is not proof of a saved region');
  await assert.rejects(offline.prepare(resource, revision), /Offline/);
});

test('inspection keeps corrupt cache untouched, acquisition repairs it, and explicit saves require durable writes', async t => {
  const { stored, cache } = cacheFixture(t);
  stored.set(resource.url, new Response(bytes.slice(0, -1)));
  const store = createRouteHistoryStore();
  assert.equal(await store.cached(resource, revision), false);
  assert.equal(stored.size, 1, 'a cache-only health check must not mutate saved files');
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(bytes.slice(0, -1)));
  await assert.rejects(store.query(resource, revision, query), /size/);
  assert.equal(stored.size, 0);
  fetch.mock.mockImplementation(async () => new Response(bytes));
  t.mock.method(cache, 'put', async () => { throw new Error('Quota exceeded'); });
  assert.equal((await store.query(resource, revision, query)).totalCount, 17, 'browsing can use memory after a quota refusal');
  await assert.rejects(store.prepare(resource, revision), /Quota exceeded/);
  assert.equal(await store.cached(resource, revision), false);
});

test('same-cycle metadata changes reload and validate the snapshot rather than reuse memory', async t => {
  cacheFixture(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(bytes));
  const store = createRouteHistoryStore();
  await store.query(resource, revision, query);
  await store.query({ ...resource, url: resource.url + '-new' }, revision, query);
  assert.equal(fetch.mock.calls.length, 2);
  await assert.rejects(store.query({ ...resource, count: 999 }, revision, query), /invalid document/);
  await assert.rejects(store.query(resource, '2026-10-01', query), /invalid document/);
});

test('temporary decompressed-body read failures preserve the cached history snapshot', async t => {
  const { stored } = cacheFixture(t);
  stored.set(resource.url, new Response(bytes));
  t.mock.method(Response.prototype, 'text', async () => { throw new DOMException('busy', 'NotReadableError'); });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Offline'); });
  const store = createRouteHistoryStore();
  assert.equal(await store.cached(resource, revision), false);
  await assert.rejects(store.query(resource, revision, query), /Offline/);
  assert.ok(stored.has(resource.url));
});

test('gzip size limits, checksum and decoded HTTP responses are handled before schema validation', async () => {
  assert.deepEqual(await parseGzipJson(new Response(json), resource), history, 'HTTP decoding can hide the encoding header behind CORS');
  await assert.rejects(parseGzipJson(new Response(bytes), { ...resource, uncompressedBytes: resource.uncompressedBytes - 1 }), /size/);
  await assert.rejects(parseGzipJson(new Response(bytes), { ...resource, uncompressedBytes: resource.uncompressedBytes + 1 }), /size/);
  const corrupt = bytes.slice(); corrupt[corrupt.length - 8]! ^= 1;
  await assert.rejects(parseGzipJson(new Response(corrupt), resource));
  await assert.rejects(parseGzipJson(new Response('<html>Missing</html>'), resource), /Invalid gzip/);
});

test('filed imports use ICAO/FAA aliases and pin both selected endpoints without dropping unknown procedures', () => {
  const airport = (faaId: string): GeoPointFeature => ({ type: 'Feature', id: `airport:${faaId}`,
    geometry: { type: 'Point', coordinates: [-119, 34] }, properties: { faaId, icaoId: `K${faaId}` } });
  const pair = { origin: airport('SBA'), destination: airport('SMO') };
  assert.deepEqual(routeHistoryQuery(pair), query);
  assert.deepEqual(draftSnapshot(filedRouteDraft('SBA..SBAP12..SMO', pair, {})), {
    input: 'KSBA SBAP12 KSMO', pinnedFeatureIds: { 0: 'airport:SBA', 2: 'airport:SMO' },
  });
  const navigation = { navaids: { type: 'FeatureCollection' as const,
    features: [{ ...airport('CMA'), id: 'navaid:CMA', properties: { ident: 'CMA' } }],
    meta: { layer: 'navaids' as const, revision, returned: 1, truncated: false } } };
  assert.deepEqual(draftSnapshot(filedRouteDraft('KSBA CMA KSMO', pair, navigation)), {
    input: 'KSBA CMA KSMO', pinnedFeatureIds: { 0: 'airport:SBA', 1: 'navaid:CMA', 2: 'airport:SMO' },
  });
});
