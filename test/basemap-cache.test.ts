import assert from 'node:assert/strict';
import test from 'node:test';
import { cacheFixture } from './helpers/cache';
import { BASEMAP_CACHE, BASEMAP_METADATA_CACHE, DATA_CACHE } from '../src/core/storage/cache-names';
import { basemapResponse, BASEMAP_MAX_AGE_MS, BASEMAP_MAX_ENTRIES, BASEMAP_MAX_BYTES,
  BASEMAP_MAX_FILE_BYTES, removeLegacyBasemapFiles, removeTemporaryBasemapFiles } from '../src/core/storage/basemap-cache';

const url = 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/3/1/1';
async function browse(target = url) {
  const work: Promise<void>[] = [];
  const response = await basemapResponse(new Request(target), promise => work.push(promise));
  const body = await response.text();
  await Promise.all(work);
  return body;
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('viewed basemaps are temporary, expire after a day and reject future cache timestamps', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
  const { stored } = cacheFixture(t, BASEMAP_CACHE);
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('tile'));
  assert.equal(await browse(), 'tile'); assert.equal(stored.size, 1);
  fetch.mock.mockImplementation(async () => { throw new Error('offline'); });
  assert.equal(await browse(), 'tile');
  t.mock.timers.tick(BASEMAP_MAX_AGE_MS);
  await assert.rejects(browse(), /offline/, 'expired tiles do not imply saved coverage');
  t.mock.timers.setTime(50_000);
  await assert.rejects(browse(), /offline/, 'clock rollback cannot extend retention');
  fetch.mock.mockImplementation(async () => new Response('new tile'));
  assert.equal(await browse(), 'new tile'); assert.equal(stored.size, 1);
});

for (const limit of ['entries', 'bytes'] as const) test(`basemap ${limit} limits survive concurrent publications`, async t => {
  const { stored, namespace } = cacheFixture(t, BASEMAP_CACHE);
  t.mock.method(globalThis, 'fetch', async () => new Response('tile'));
  await browse();
  const metadata = namespace(BASEMAP_METADATA_CACHE).stored;
  const headers = new Headers(stored.get(url)!.headers);
  const entryBytes = limit === 'bytes' ? BASEMAP_MAX_FILE_BYTES : 4;
  headers.set('content-length', String(entryBytes));
  stored.clear(); metadata.clear();
  const count = limit === 'bytes' ? BASEMAP_MAX_BYTES / entryBytes : BASEMAP_MAX_ENTRIES;
  for (let i = 0; i < count; i++) {
    stored.set(`${url}?old=${i}`, new Response('tile', { headers }));
    metadata.set(`${url}?old=${i}`, new Response(null, { headers }));
  }
  await Promise.all([browse(`${url}?new=1`), browse(`${url}?new=2`)]);
  assert.ok(stored.size <= BASEMAP_MAX_ENTRIES);
  assert.ok([...stored.values()].reduce((sum, value) => sum + Number(value.headers.get('content-length')), 0) <= BASEMAP_MAX_BYTES);
  assert.equal(stored.has(`${url}?old=0`), false, 'oldest temporary files make room');
  assert.ok(stored.has(`${url}?new=1`)); assert.ok(stored.has(`${url}?new=2`));
});

test('oversized and opaque basemap responses stay usable without being saved', async t => {
  const { stored } = cacheFixture(t, BASEMAP_CACHE);
  t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(BASEMAP_MAX_FILE_BYTES + 1)));
  assert.equal((await browse()).length, BASEMAP_MAX_FILE_BYTES + 1);
  assert.equal(stored.size, 0);
  // Fetch exposes an opaque response with status zero and an unreadable body.
  t.mock.method(globalThis, 'fetch', async () => Response.error());
  await browse(); assert.equal(stored.size, 0);
});

test('optional basemap writes never delay display and remain tracked until actual publication settles', async t => {
  const { cache, stored } = cacheFixture(t, BASEMAP_CACHE), writing = gate(), finish = gate();
  const put = cache.put;
  t.mock.method(cache, 'put', async (key: RequestInfo | URL, response: Response) => {
    writing.resolve(); await finish.promise; return put(key, response);
  });
  t.mock.method(globalThis, 'fetch', async () => new Response('tile'));
  const work: Promise<void>[] = [];
  const response = await basemapResponse(new Request(url), promise => work.push(promise));
  assert.equal(await response.text(), 'tile');
  await writing.promise;
  let settled = false;
  const pending = Promise.all(work).then(() => { settled = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.equal(stored.size, 0);
  finish.resolve(); await pending; assert.equal(stored.size, 1);
});

test('denied basemap storage and quota exhaustion keep network responses usable', async t => {
  const { cache, stored } = cacheFixture(t, BASEMAP_CACHE);
  t.mock.method(globalThis, 'fetch', async () => new Response('tile'));
  await browse();
  const put = cache.put;
  t.mock.method(cache, 'put', async (key: RequestInfo | URL, response: Response) => {
    if (stored.size) throw new DOMException('Full', 'QuotaExceededError');
    return put(key, response);
  });
  assert.equal(await browse(`${url}?new`), 'tile');
  assert.equal(stored.has(url), false); assert.equal(stored.size, 1);
  t.mock.method(caches, 'match', async () => { throw new Error('Denied'); });
  t.mock.method(caches, 'open', async () => { throw new Error('Denied'); });
  assert.equal(await browse(`${url}?denied`), 'tile');
});

test('rapid basemap requests bound pending copies and resume caching after publication', async t => {
  const { cache, stored } = cacheFixture(t, BASEMAP_CACHE), writing = gate(), finish = gate();
  const put = cache.put;
  t.mock.method(cache, 'put', async (key: RequestInfo | URL, response: Response) => {
    writing.resolve(); await finish.promise; return put(key, response);
  });
  t.mock.method(globalThis, 'fetch', async () => new Response('tile'));
  const work: Promise<void>[] = [];
  try {
    const bodies = await Promise.all(Array.from({ length: 40 }, async (_, i) => {
      const response = await basemapResponse(new Request(`${url}?pan=${i}`), promise => work.push(promise));
      return response.text();
    }));
    await writing.promise;
    assert.ok(bodies.every(body => body === 'tile'), 'storage pressure never delays network display');
    assert.equal(work.length, 4, 'admission includes both body reading and queued publication');
  } finally { finish.resolve(); await Promise.all(work); }
  assert.equal(stored.size, 4);
  assert.equal(await browse(`${url}?after-pressure`), 'tile');
  assert.equal(stored.size, 5, 'settled writes release admission');
});

test('legacy cleanup and explicit temporary-file removal preserve regional reference data', async t => {
  const { stored, namespace } = cacheFixture(t, BASEMAP_CACHE);
  t.mock.method(globalThis, 'fetch', async () => new Response('tile'));
  await browse();
  const data = namespace(DATA_CACHE), reference = 'https://charts.test/nav/airports.json';
  data.stored.set(url, new Response('unbounded legacy tile'));
  data.stored.set(reference, Response.json({ saved: true }));
  await removeLegacyBasemapFiles();
  assert.deepEqual([...data.stored.keys()], [reference]); assert.equal(stored.size, 1);
  data.stored.set(url, new Response('late legacy tile'));
  await removeTemporaryBasemapFiles();
  assert.equal((await caches.keys()).includes(BASEMAP_CACHE), false);
  assert.equal((await caches.keys()).includes(BASEMAP_METADATA_CACHE), false);
  assert.deepEqual([...data.stored.keys()], [reference]);
});
