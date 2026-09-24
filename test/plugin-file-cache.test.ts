import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginStorage } from '../src/core/storage/plugin-storage';
import { ResourceError } from '../src/core/data/errors';
import { cacheFixture } from './helpers/cache';
import { createTaskLimiter } from '../src/core/data/task-limiter';
import { pluginFileKey, readDerivedArtifact } from '../src/core/storage/plugin-file-cache';

const policy = { maxEntries: 3, maxBytes: 12, maxFileBytes: 8, maxUnusedMs: 1000 };
const scope = createPluginStorage('cache-test');
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
test('file inventory follows shared-budget eviction without reading bodies or touching LRU', async t => {
  const owner = createPluginStorage('inventory-test', undefined, { fileBudget: { maxEntries: 1, maxBytes: 8, maxUnusedMs: 1000 } });
  const first = owner.files('first', policy), second = owner.files('second', policy);
  const { cache } = cacheFixture(t, first.cacheName);
  t.mock.method(globalThis, 'fetch', async () => new Response('ok'));
  let changes = 0, unrelated = 0;
  const stop = owner.subscribeFiles(() => { changes++; });
  const other = scope.subscribeFiles(() => { unrelated++; });
  const broken = owner.subscribeFiles(() => { throw new Error('Observer unavailable'); });
  t.after(() => { stop(); other(); broken(); });
  await first.load(request('one')); await turn();
  const published = changes;
  await second.load(request('two')); await turn();
  assert.ok(changes > published); assert.equal(unrelated, 0);
  const reads = t.mock.method(cache, 'match', async () => { throw new Error('Inventory must not read a body'); });
  assert.deepEqual(await first.retained([request('one'), request('absent')], new AbortController().signal), [false, false]);
  assert.deepEqual(await second.retained([request('two')], new AbortController().signal), [true]);
  assert.equal(reads.mock.callCount(), 0);
  stop(); broken();
  let resumed = 0;
  const resume = owner.subscribeFiles(() => { resumed++; }); t.after(resume);
  stop(); // An old teardown cannot remove a newer subscription.
  await second.load(request('three')); await turn(); assert.ok(resumed > 0);
});

test('eviction during decoding preserves live data but reports that the file is no longer saved', async t => {
  const files = scope.files('read-eviction', policy), { stored } = cacheFixture(t, files.cacheName);
  t.mock.method(globalThis, 'fetch', async () => new Response('ok'));
  const source = request('evicted'); await files.load(source);
  const result = await files.loadResult({ ...source, cacheOnly: true, validate: async bytes => {
    stored.delete(pluginFileKey(source)); return source.validate(bytes);
  } });
  assert.deepEqual(result, { value: 'ok', saved: false });
});

test('validated readiness precedes encoding and persistence, reaches late joiners, and respects independent cancellation', async t => {
  const files = scope.files('early-ready', policy), { stored } = cacheFixture(t, files.cacheName);
  const encode = gate(), ready = gate(), first = new AbortController();
  let creates = 0, completed = false;
  const seen: string[] = [];
  const options = { url: 'https://test/early', identity: 'v1', label: 'Early', signal: first.signal,
    async create(_signal: AbortSignal, notify: (value: string) => void) {
      creates++; notify('ok'); ready.resolve(); await encode.promise;
      return new TextEncoder().encode('ok').buffer;
    }, validate: async (bytes: ArrayBuffer) => new TextDecoder().decode(bytes), onReady: (value: string) => { seen.push(value); } };
  const a = files.deriveResult(options);
  const aborted = assert.rejects(a, /abort/i);
  await ready.promise;
  const b = files.deriveResult({ ...options, signal: new AbortController().signal }).then(result => { completed = true; return result; });
  assert.deepEqual(seen, ['ok', 'ok']); assert.equal(stored.size, 0); assert.equal(completed, false);
  first.abort(); await aborted; encode.resolve();
  assert.deepEqual(await b, { value: 'ok', saved: true }); assert.equal(creates, 1);
  assert.equal(stored.size, 1); assert.deepEqual(seen, ['ok', 'ok']);
  await files.deriveResult({ ...options, signal: new AbortController().signal });
  assert.deepEqual(seen, ['ok', 'ok', 'ok']); assert.equal(creates, 1);
});

test('a failed readiness observer cannot corrupt a valid derived artifact', async t => {
  const files = scope.files('observer-error', policy); cacheFixture(t, files.cacheName);
  const result = await files.deriveResult({ url: 'https://test/observer', identity: 'v1', label: 'Observer', signal: new AbortController().signal,
    create: async () => new TextEncoder().encode('ok').buffer, validate: async bytes => new TextDecoder().decode(bytes),
    onReady() { throw new Error('UI failed'); } });
  assert.deepEqual(result, { value: 'ok', saved: true });
});
test('decoder worker failures retain valid saved bytes for recovery without another download', async t => {
  const files = scope.files('worker-recovery', policy), { stored } = cacheFixture(t, files.cacheName);
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('ok'));
  await files.load(request('weather'));
  await assert.rejects(files.load({ ...request('weather'), validate: async () => { throw new ResourceError('worker', 'Decoder crashed'); } }), /Decoder crashed/);
  assert.equal(stored.size, 1);
  assert.equal(await files.load(request('weather', { cacheOnly: true })), 'ok');
  assert.equal(fetch.mock.callCount(), 1);
});

test('a cache hit reads one file body and batches retention receipts for a full timeline cache', async t => {
  const files = scope.files('inventory', { ...policy, maxEntries: 64, maxBytes: 128 });
  const { cache } = cacheFixture(t, files.cacheName);
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('ok'));
  for (let i = 0; i < 64; i++) await files.load(request(`frame-${i}`));
  const metadata = await caches.open(`${files.cacheName}:access`);
  const reads = t.mock.method(cache, 'match'), individual = t.mock.method(metadata, 'match'), batch = t.mock.method(metadata, 'matchAll');
  assert.equal(await files.load(request('frame-0')), 'ok');
  assert.equal(reads.mock.callCount(), 1, 'retention must not reread cached bodies');
  assert.equal(individual.mock.callCount(), 0);
  assert.equal(batch.mock.callCount(), 1);
  assert.equal(fetch.mock.callCount(), 64);
});

test('derived artifacts convert once, coalesce producers, survive offline reopening and repair corruption', async t => {
  const files = scope.files('derived', policy), { stored } = cacheFixture(t, files.cacheName);
  let conversions = 0;
  const options = { url: 'https://test/source.grib2', identity: 'source-cycle/decoder-v1/' + 'field-range-identity'.repeat(100), label: 'Converted weather', signal: new AbortController().signal,
    create: async () => { conversions++; await turn(); return new TextEncoder().encode('ok').buffer; },
    validate: async (bytes: ArrayBuffer) => new TextDecoder().decode(bytes) };
  assert.deepEqual(await Promise.all([files.derive(options), files.derive(options)]), ['ok', 'ok']);
  assert.equal(conversions, 1);
  assert.equal(await scope.files('derived', policy).derive({ ...options, cacheOnly: true }), 'ok');
  assert.equal(conversions, 1);
  const key = [...stored.keys()][0]!, original = stored.get(key)!;
  stored.set(key, new Response('xx', { headers: original.headers }));
  assert.equal(await files.derive(options), 'ok');
  assert.equal(conversions, 2, 'core validates the saved artifact checksum before the plugin reads it');
  await assert.rejects(files.derive({ ...options, identity: 'decoder-v2', cacheOnly: true }), /not saved/);
  await assert.rejects(files.derive({ ...options, identity: 'oversized', create: async () => new ArrayBuffer(9) }), /limits/);
});

test('derived migrations preserve their same-namespace source until a replacement fits and is saved', async t => {
  const files = scope.files('derived-migration', { ...policy, maxEntries: 1 });
  const { cache, stored } = cacheFixture(t, files.cacheName);
  const source = { url: 'https://test/migration', identity: 'old', label: 'Migration', signal: new AbortController().signal,
    create: async () => new TextEncoder().encode('ok').buffer,
    validate: async (bytes: ArrayBuffer) => new TextDecoder().decode(bytes) };
  await files.derive(source);
  const oldKey = pluginFileKey(source);
  const migration = { ...source, identity: 'new', cacheOnly: true,
    legacy: [{ cache: files.cacheName, key: oldKey,
      convert: (response: Response, signal: AbortSignal) => readDerivedArtifact(response, policy.maxFileBytes, signal) }] };
  assert.deepEqual(await files.deriveResult(migration), { value: 'ok', saved: false });
  assert.equal(stored.has(oldKey), true, 'local entry limits cannot evict the migration source');
  const roomy = scope.files('derived-migration', { ...policy, maxEntries: 2 });
  const put = t.mock.method(cache, 'put', async () => { throw new DOMException('Full', 'QuotaExceededError'); });
  assert.deepEqual(await roomy.deriveResult(migration), { value: 'ok', saved: false });
  assert.equal(stored.has(oldKey), true, 'quota recovery cannot evict the migration source');
  put.mock.restore();
  assert.deepEqual(await roomy.deriveResult(migration), { value: 'ok', saved: true });
  assert.equal(stored.has(oldKey), false); assert.equal(stored.size, 1);
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function request(name: string, options: Partial<{
  identity: string; signal: AbortSignal; byteLength: number; cacheOnly: boolean;
}> = {}) {
  return { url: `https://test/${name}`, identity: 'format-v1', byteLength: 2, label: 'Test file',
    signal: new AbortController().signal,
    validate: async (bytes: ArrayBuffer) => {
      const value = new TextDecoder().decode(bytes);
      if (value === 'xx') throw new Error('Invalid file contents');
      return value;
    }, ...options };
}

test('plugin file caches reuse validated bytes offline, isolate namespaces and source/decoder identities', async t => {
  const files = scope.files('identity', policy), { stored } = cacheFixture(t, files.cacheName);
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('ok'));
  assert.equal(await files.load(request('a')), 'ok');
  assert.equal(await scope.files('identity', policy).load(request('a', { cacheOnly: true })), 'ok');
  await assert.rejects(scope.files('other', policy).load(request('a', { cacheOnly: true })), /not saved/);
  await assert.rejects(createPluginStorage('other-plugin').files('identity', policy).load(request('a', { cacheOnly: true })), /not saved/);
  await assert.rejects(files.load(request('a', { identity: 'replacement', cacheOnly: true })), /not saved/);
  assert.equal(await files.load(request('a', { identity: 'replacement' })), 'ok');
  assert.equal(stored.size, 2);
  assert.equal(fetch.mock.callCount(), 2);
});

test('LRU hits reorder only metadata, including tied clocks; byte/count budgets evict the unused file', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  const files = scope.files('lru', { ...policy, maxEntries: 4, maxBytes: 6, maxFileBytes: 6 });
  const { stored, cache } = cacheFixture(t, files.cacheName);
  t.mock.method(globalThis, 'fetch', async () => new Response('ok'));
  for (const name of ['a', 'b', 'c']) await files.load(request(name));
  const writes = t.mock.method(cache, 'put');
  await files.load(request('a')); // Same timestamp, still the most recently used file.
  assert.equal(writes.mock.callCount(), 0, 'a hit must not rewrite its file body');
  await files.load(request('d'));
  assert.deepEqual([...stored.keys()].map(key => new URL(key).pathname).sort(), ['/a', '/c', '/d']);
  await assert.rejects(files.load(request('b', { cacheOnly: true })), /not saved/);
  const limited = scope.files('lru', { ...policy, maxEntries: 2 });
  await limited.load(request('a'));
  assert.deepEqual([...stored.keys()].map(key => new URL(key).pathname).sort(), ['/a', '/d']);
});

test('unused-file age cleanup and clock rollback do not relabel source data or prevent cache reuse', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  const files = scope.files('ages', policy), { stored } = cacheFixture(t, files.cacheName);
  t.mock.method(globalThis, 'fetch', async () => new Response('ok'));
  await files.load(request('old'));
  t.mock.timers.setTime(12000);
  await files.load(request('recent'));
  assert.equal(stored.size, 1);
  t.mock.timers.setTime(5000);
  assert.equal(await files.load(request('recent', { cacheOnly: true })), 'ok');
  await files.load(request('another'));
  assert.equal(stored.size, 2, 'future access timestamps get a new grace period');
});

test('corrupt, truncated and oversized cached bodies are removed; only validated network replacements persist', async t => {
  const files = scope.files('corruption', policy), { stored, cache } = cacheFixture(t, files.cacheName);
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('ok'));
  await files.load(request('a'));
  const key = [...stored.keys()][0]!;
  for (const body of ['xx', 'o', 'oversized']) {
    await cache.put(key, new Response(body, { headers: { 'content-length': '2' } }));
    assert.equal(await files.load(request('a')), 'ok');
  }
  assert.equal(fetch.mock.callCount(), 4);
  await cache.put(key, new Response('xx'));
  await assert.rejects(files.load(request('a', { cacheOnly: true })), /Invalid file/);
  assert.equal(stored.size, 0);
  fetch.mock.mockImplementation(async () => new Response('xx'));
  await assert.rejects(files.load(request('a')), /Invalid file/);
  assert.equal(stored.size, 0);
  assert.throws(() => files.load(request('a', { byteLength: 9 })), /cache limits/);
});

test('legacy files migrate only after validation and keep working offline without a new transfer', async t => {
  const legacy = cacheFixture(t, 'zlayers-old-plugin-files');
  await legacy.cache.put('https://test/a', new Response('ok'));
  const files = scope.files('migration', { ...policy, legacyCache: 'zlayers-old-plugin-files' });
  t.mock.method(globalThis, 'fetch', async () => assert.fail('migration must not fetch'));
  assert.equal(await files.load(request('a', { cacheOnly: true })), 'ok');
  assert.equal(legacy.stored.size, 0);
  assert.equal(await files.load(request('a', { cacheOnly: true })), 'ok');
});

test('a late corrupt cache-only read cannot remove a concurrently repaired file', async t => {
  const files = scope.files('repair-race', policy), { stored, cache } = cacheFixture(t, files.cacheName);
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('ok'));
  await files.load(request('a'));
  await cache.put([...stored.keys()][0]!, new Response('xx'));
  const inspecting = gate(), release = gate();
  const badRead = assert.rejects(files.load({ ...request('a', { cacheOnly: true }), validate: async () => {
    inspecting.resolve(); await release.promise; throw new Error('Corrupt old response');
  } }), /Corrupt old response/);
  await inspecting.promise;
  assert.equal(await files.load(request('a')), 'ok');
  release.resolve(); await badRead;
  assert.equal(await files.load(request('a', { cacheOnly: true })), 'ok');
  assert.equal(fetch.mock.callCount(), 2);
});

test('coalesced callers cancel independently; all-consumer cancellation stops work and allows an immediate retry', async t => {
  const files = scope.files('shared', policy); cacheFixture(t, files.cacheName);
  const entered = gate(), release = gate();
  let networkSignal: AbortSignal | undefined;
  const fetch = t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    networkSignal = options.signal!; entered.resolve(); await release.promise; return new Response('ok');
  });
  const first = new AbortController(), second = new AbortController();
  const canceled = assert.rejects(files.load(request('a', { signal: first.signal })), { name: 'AbortError' });
  const kept = scope.files('shared', policy).load(request('a', { signal: second.signal }));
  await entered.promise; first.abort(); await canceled;
  assert.equal(networkSignal!.aborted, false);
  release.resolve(); assert.equal(await kept, 'ok');
  assert.equal(fetch.mock.callCount(), 1);

  const started = gate();
  fetch.mock.mockImplementation(async (_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
    networkSignal = options.signal!; started.resolve();
    networkSignal.addEventListener('abort', () => reject(networkSignal!.reason), { once: true });
  }));
  const obsolete = new AbortController();
  const abandoned = assert.rejects(files.load(request('b', { signal: obsolete.signal })), { name: 'AbortError' });
  await started.promise; obsolete.abort(); await abandoned;
  assert.equal(networkSignal!.aborted, true);
  fetch.mock.mockImplementation(async () => new Response('ok'));
  assert.equal(await files.load(request('b')), 'ok');
});

test('cache-only demand never joins or waits for an in-flight network fetch', async t => {
  const files = scope.files('cache-only', policy); cacheFixture(t, files.cacheName);
  const entered = gate(), release = gate();
  t.mock.method(globalThis, 'fetch', async () => { entered.resolve(); await release.promise; return new Response('ok'); });
  const online = files.load(request('a')); await entered.promise;
  await assert.rejects(files.load(request('a', { cacheOnly: true })), /not saved/);
  release.resolve(); await online;
});

test('quota pressure evicts this cache’s LRU entries and persistence failures never discard validated live data', async t => {
  const files = scope.files('quota', policy), { cache, stored } = cacheFixture(t, files.cacheName);
  t.mock.method(globalThis, 'fetch', async () => new Response('ok'));
  await files.load(request('a')); await files.load(request('b'));
  const put = cache.put;
  t.mock.method(cache, 'put', async (...args: Parameters<typeof put>) => {
    if (stored.size >= 1) throw new DOMException('Full', 'QuotaExceededError');
    return put(...args);
  });
  assert.equal(await files.load(request('c')), 'ok');
  assert.deepEqual([...stored.keys()].map(key => new URL(key).pathname), ['/c']);
  t.mock.method(cache, 'put', async () => { throw new Error('Storage denied'); });
  assert.equal(await files.load(request('d')), 'ok');
  await assert.rejects(files.load(request('d', { cacheOnly: true })), /not saved/);
});

test('denied cache/lock access keeps online reads usable and does not make unsafe persistent writes', async t => {
  const files = scope.files('denied', policy), { stored } = cacheFixture(t, files.cacheName);
  t.mock.method(globalThis, 'fetch', async () => new Response('ok'));
  const original = Object.getOwnPropertyDescriptor(navigator, 'locks');
  Object.defineProperty(navigator, 'locks', { configurable: true, get() { throw new Error('Denied'); } });
  t.after(() => original ? Object.defineProperty(navigator, 'locks', original) : Reflect.deleteProperty(navigator, 'locks'));
  assert.equal(await files.load(request('a')), 'ok');
  assert.equal(stored.size, 0);
  Object.defineProperty(globalThis, 'caches', { configurable: true, get() { throw new Error('Denied'); } });
  assert.equal(await files.load(request('b')), 'ok');
  await assert.rejects(files.load(request('b', { cacheOnly: true })), /not saved/);
  await turn();
});

const fileBudget = { maxEntries: 3, maxBytes: 6, maxUnusedMs: 1000 };
const budgetScope = (budget = fileBudget) => createPluginStorage('budget-test', undefined, { fileBudget: budget });
const budgetPolicy = { ...policy, maxFileBytes: 6 };
async function paths(name: string) {
  return (await (await caches.open(name)).keys()).map(key => new URL(key.url).pathname).sort();
}

test('one plugin budget evicts across namespaces, with ordered LRU hits despite clock ties and rollback', async t => {
  cacheFixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  t.mock.method(globalThis, 'fetch', async () => new Response('ok'));
  const a = budgetScope().files('clouds', budgetPolicy), b = budgetScope().files('winds', budgetPolicy);
  const unrelated = createPluginStorage('unrelated').files('winds', policy);
  await unrelated.load(request('other-plugin'));
  await a.load(request('a')); await b.load(request('b')); await a.load(request('c'));
  const body = await caches.open(a.cacheName), reads = t.mock.method(body, 'match'), writes = t.mock.method(body, 'put');
  t.mock.timers.setTime(5000);
  await a.load(request('a'));
  assert.equal(reads.mock.callCount(), 1); assert.equal(writes.mock.callCount(), 0);
  await b.load(request('d'));
  assert.deepEqual(await paths(a.cacheName), ['/a', '/c']);
  assert.deepEqual(await paths(b.cacheName), ['/d']);
  assert.deepEqual(await paths(unrelated.cacheName), ['/other-plugin']);
  await assert.rejects(b.load(request('b', { cacheOnly: true })), /not saved/);
});

test('budget adoption/shrinking counts dormant namespaces and applies count, byte and age limits', async t => {
  cacheFixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  t.mock.method(globalThis, 'fetch', async () => new Response('ok'));
  const old = createPluginStorage('budget-test').files('old-source', policy);
  for (const name of ['a', 'b', 'c']) await old.load(request(name));
  const current = budgetScope().files('new-source', budgetPolicy);
  await current.load(request('d'));
  assert.deepEqual(await paths(old.cacheName), ['/b', '/c']);
  const smaller = budgetScope({ ...fileBudget, maxEntries: 1 }).files('new-source', budgetPolicy);
  await smaller.load(request('d', { cacheOnly: true }));
  assert.deepEqual(await paths(old.cacheName), []);
  await current.load(request('e'));
  t.mock.timers.setTime(12000);
  await current.load(request('f'));
  assert.deepEqual(await paths(current.cacheName), ['/f']);
  const bytes = budgetScope({ ...fileBudget, maxEntries: 10, maxBytes: 2 }).files('another-source', { ...policy, maxFileBytes: 2 });
  await bytes.load(request('g'));
  assert.deepEqual(await paths(current.cacheName), []);
});

test('parallel namespace publications from separate storage scopes cannot exceed the plugin budget', async t => {
  cacheFixture(t);
  t.mock.method(globalThis, 'fetch', async () => { await turn(); return new Response('ok'); });
  const a = budgetScope().files('clouds', budgetPolicy), b = budgetScope().files('winds', budgetPolicy);
  await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).load(request(`frame-${i}`))));
  assert.equal((await paths(a.cacheName)).length + (await paths(b.cacheName)).length, 3);
});

test('quota recovery can evict another namespace while denied inventory makes persistence optional', async t => {
  cacheFixture(t);
  t.mock.method(globalThis, 'fetch', async () => new Response('ok'));
  const a = budgetScope().files('clouds', budgetPolicy), b = budgetScope().files('winds', budgetPolicy);
  await a.load(request('a'));
  const target = await caches.open(b.cacheName), put = target.put.bind(target);
  t.mock.method(target, 'put', async (...args: Parameters<Cache['put']>) => {
    if ((await paths(a.cacheName)).length) throw new DOMException('Full', 'QuotaExceededError');
    return put(...args);
  });
  assert.equal(await b.load(request('b')), 'ok');
  assert.deepEqual(await paths(a.cacheName), []);
  t.mock.method(caches, 'keys', async () => { throw new Error('Denied inventory'); });
  assert.equal(await b.load(request('c')), 'ok');
  assert.deepEqual(await paths(b.cacheName), ['/b'], 'never publish outside a budget that cannot be checked');
});

test('legacy files count toward the shared budget without reading bodies and migrations protect the source on failure', async t => {
  const legacyName = 'zlayers-old-budget-weather', legacy = cacheFixture(t, legacyName);
  for (const name of ['a', 'b']) await legacy.cache.put(`https://test/${name}`, new Response('ok'));
  const options = { ...fileBudget, maxBytes: 8, legacyCaches: { [legacyName]: 4 } };
  const owner = createPluginStorage('budget-test', undefined, { fileBudget: options });
  const files = owner.files('grids', { ...budgetPolicy, legacyCache: legacyName });
  t.mock.method(globalThis, 'fetch', async () => assert.fail('migration must work offline'));
  assert.equal(await files.load(request('a', { cacheOnly: true })), 'ok');
  assert.equal(legacy.stored.size, 0, 'one old file migrates, the other makes room under the aggregate ceiling');
  assert.deepEqual(await paths(files.cacheName), ['/a']);
  await legacy.cache.put('https://test/b', new Response('ok'));
  const destination = await caches.open(files.cacheName);
  t.mock.method(destination, 'put', async () => { throw new DOMException('Denied', 'QuotaExceededError'); });
  assert.equal(await files.load(request('b', { cacheOnly: true })), 'ok');
  assert.equal(legacy.stored.size, 1, 'failed migration retains the readable legacy source');
});

test('shared expensive-work admission preserves coalescing and cancels queued work before cache/network reads', async t => {
  cacheFixture(t);
  const run = createTaskLimiter(1), started = gate(), release = gate();
  const a = scope.files('admitted-a', policy), b = scope.files('admitted-b', policy);
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('ok'));
  let validations = 0;
  const options = { ...request('a'), run, validate: async () => { validations++; started.resolve(); await release.promise; return 'ok'; } };
  const first = a.load(options), shared = a.load(options);
  await started.promise;
  const cancel = new AbortController();
  const cancelled = assert.rejects(b.load({ ...request('b', { signal: cancel.signal }), run }), /abort/i);
  await turn(); cancel.abort(); await cancelled;
  assert.equal(fetch.mock.callCount(), 1);
  release.resolve();
  assert.deepEqual(await Promise.all([first, shared]), ['ok', 'ok']);
  assert.equal(validations, 1);
  assert.equal(await b.load({ ...request('b'), run }), 'ok');
});

test('a stalled optional cache read releases decode admission after its deadline', { timeout: 10_000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const files = scope.files('stalled-read', policy), { cache } = cacheFixture(t, files.cacheName);
  const limiter = createTaskLimiter(1), started: string[] = [], reading = gate();
  const match = cache.match;
  t.mock.method(cache, 'match', async (key: RequestInfo | URL) => {
    if (String(key).includes('/stalled?')) {
      reading.resolve();
      return new Promise<Response | undefined>(() => {});
    }
    return match(key);
  });
  t.mock.method(globalThis, 'fetch', async (url: string) => { started.push(url); return new Response('ok'); });
  const stalled = files.load({ ...request('stalled'), run: limiter });
  const following = files.load({ ...request('following'), run: limiter });
  await reading.promise;
  assert.equal(started.length, 0);
  t.mock.timers.tick(10_000);
  assert.deepEqual(await Promise.all([stalled, following]), ['ok', 'ok']);
  assert.equal(started.length, 2, 'storage cannot permanently poison the single processing slot');
});

test('a timed-out publication keeps its mutation lock while later live results remain usable', { timeout: 10_000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const files = scope.files('stalled-put', policy), { cache } = cacheFixture(t, files.cacheName);
  const put = cache.put, pending = gate(), writing = gate(), queued = gate();
  let writes = 0;
  const requestLock = navigator.locks.request;
  t.mock.method(navigator.locks, 'request', (name: string, ...args: unknown[]) => {
    if (name.endsWith(':publication') && writes === 1) queued.resolve();
    return Reflect.apply(requestLock, navigator.locks, [name, ...args]);
  });
  t.mock.method(cache, 'put', async (key: RequestInfo | URL, response: Response) => {
    writes++;
    if (writes === 1) { writing.resolve(); await pending.promise; }
    return put(key, response);
  });
  t.mock.method(globalThis, 'fetch', async () => new Response('ok'));
  const first = files.loadResult(request('first'));
  await writing.promise;
  t.mock.timers.tick(10_000);
  assert.deepEqual(await first, { value: 'ok', saved: false });
  const second = files.loadResult(request('second'));
  await queued.promise;
  t.mock.timers.tick(10_000);
  assert.deepEqual(await second, { value: 'ok', saved: false });
  assert.equal(writes, 1, 'the actual first write still owns publication');
  pending.resolve(); await turn();
  assert.deepEqual(await files.loadResult(request('third')), { value: 'ok', saved: true });
});

test('derived values too large to serialize can remain usable without claiming persistence', async t => {
  const files = scope.files('memory-only', policy), { stored } = cacheFixture(t, files.cacheName);
  const value = { records: 100 };
  const result = await files.deriveResult({ url: 'https://test/source', identity: 'large-index', label: 'Index',
    signal: new AbortController().signal, create: async () => ({ value }),
    validate: async () => { throw new Error('No encoded artifact should be allocated'); },
  });
  assert.deepEqual(result, { value, saved: false });
  assert.equal(stored.size, 0);
});
