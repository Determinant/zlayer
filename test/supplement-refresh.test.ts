import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { ChartSupplementCatalog } from '@zlayer/contracts';
import { cacheFixture } from './helpers/cache';

// Exercise the real network/cache path while controlling legacy snapshot migration.
const preservation = { blocked: false, seen: [] as ChartSupplementCatalog[] };
Object.assign(globalThis, { supplementPreservationTest: preservation });
const loader = registerHooks({ resolve(specifier, context, next) {
  if (specifier.endsWith('/compatibility/legacy-supplements')) return {
    url: 'data:text/javascript,' + encodeURIComponent(`
      export async function preserveSavedSupplements(catalog) {
        const state = globalThis.supplementPreservationTest;
        state.seen.push(catalog);
        if (state.blocked) throw new Error('Saved snapshot storage unavailable');
      }
    `), shortCircuit: true,
  };
  return next(specifier, context);
} });
const { readSupplementCatalog } = await import('../src/offline/supplement-catalog');
loader.deregister();

const original: ChartSupplementCatalog = {
  schemaVersion: 3, builderVersion: 3, generatedAt: '2026-09-03T09:01:00Z',
  effectiveDate: '2026-09-03', expirationDate: '2026-10-29',
  sourceXml: { url: 'https://faa.test/afd.xml', sha256: 'a'.repeat(64) },
  volumes: [{ id: 'SW', url: `cs-sw.${'b'.repeat(64)}.pdf`, pageCount: 2,
    byteLength: 2000, sha256: 'b'.repeat(64) }],
  airports: [{ faaId: 'HWD', name: 'HAYWARD EXEC', city: 'HAYWARD', state: 'CALIFORNIA',
    volumeId: 'SW', printedPage: '174', pageIndex: 1 }],
};

test('offline fallback and failed snapshot preservation can refresh later in the same session', async t => {
  const { cache } = cacheFixture(t);
  const location = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://zlayer.test/' } });
  t.after(() => location ? Object.defineProperty(globalThis, 'location', location) : Reflect.deleteProperty(globalThis, 'location'));
  const url = 'https://charts.test/2026-10-01/cs/catalog.json';
  const revision = '2026-10-01';
  await cache.put(url, Response.json(original));
  let online = false;
  let requests = 0;
  const corrected = { ...original, generatedAt: '2026-10-01T10:00:00Z',
    volumes: original.volumes.map(volume => ({ ...volume, sha256: 'c'.repeat(64),
      url: `cs-sw.${'c'.repeat(64)}.pdf` })) };
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    requests++;
    assert.equal(String(input), url);
    assert.equal(init?.cache, 'no-store');
    if (!online) throw new TypeError('Offline');
    return Response.json(corrected);
  });
  preservation.blocked = false;
  preservation.seen = [];
  assert.deepEqual(await readSupplementCatalog(url, revision), original);
  assert.equal(requests, 1);
  online = true;
  preservation.blocked = true;
  assert.deepEqual(await readSupplementCatalog(url, revision), original);
  assert.equal(requests, 1, 'preservation failure keeps the mutable cache untouched');
  assert.deepEqual(await (await cache.match(url))!.json(), original);
  preservation.blocked = false;
  const [a, b] = await Promise.all([readSupplementCatalog(url, revision), readSupplementCatalog(url, revision)]);
  assert.equal(a, b, 'concurrent readers share one refresh');
  assert.deepEqual(a, corrected);
  assert.equal(requests, 2);
  assert.deepEqual(preservation.seen, [original, original, original]);
  assert.deepEqual(await (await cache.match(url))!.json(), corrected);
});
