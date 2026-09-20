import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { cacheFixture } from './helpers/cache';
import { CHART_CACHE, VERIFIED_SHA256_HEADER } from '../src/core/storage/cache-names';

const shellHtml = '<meta name="zlayer-release" content="dev">';

async function workerFixture(t: TestContext) {
  const { cache, stored } = cacheFixture(t);
  Object.assign(caches, { match: async (request: RequestInfo | URL, options?: MultiCacheQueryOptions) =>
    options?.cacheName ? (await caches.open(options.cacheName)).match(request) : cache.match(request) });
  type Message = { data: unknown; source: { id: string; url: string }; ports: { postMessage: (value: unknown) => void }[];
    waitUntil: (work: Promise<unknown>) => void };
  type Fetch = { request: Request; respondWith: (response: Promise<Response>) => void; waitUntil: (work: Promise<unknown>) => void };
  let onMessage!: (event: Message) => void, onFetch!: (event: Fetch) => void;
  const client = { id: 'reset-screen', url: 'https://app.test/?reset=1', postMessage: () => {} };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'self');
  const clients = { matchAll: async (): Promise<{ id: string; url: string; navigate?: (url: string) => Promise<unknown> }[]> => [client],
    claim: async () => {} };
  Object.defineProperty(globalThis, 'self', { configurable: true, value: Object.assign(Object.create(globalThis), {
    location: { pathname: '/sw.js', origin: 'https://app.test' },
    clients,
    addEventListener(type: string, listener: never) {
      if (type === 'fetch') onFetch = listener;
      if (type === 'message') onMessage = listener;
    },
  }) });
  t.after(() => original ? Object.defineProperty(globalThis, 'self', original) : Reflect.deleteProperty(globalThis, 'self'));
  await import(`../src/service-worker.ts?test=${encodeURIComponent(t.name)}`);
  return { cache, stored, client, clients,
    onMessage: (event: Message) => onMessage(event), onFetch: (event: Fetch) => onFetch(event) };
}

test('reset drains worker writes, prevents new writes, and discards resident charts before revival', async t => {
  const { stored, client, onMessage, onFetch } = await workerFixture(t);
  let finishFetch!: (response: Response) => void, fetching!: () => void;
  const started = new Promise<void>(resolve => { fetching = resolve; });
  const network = new Promise<Response>(resolve => { finishFetch = resolve; });
  const fetch = t.mock.method(globalThis, 'fetch', async () => { fetching(); return network; });
  let response!: Promise<Response>;
  const chartUrl = `https://charts.tedyin.com/charts/reset.mbtiles?bytes=5&sha256=${'a'.repeat(64)}`;
  const charts = await caches.open(CHART_CACHE);
  await charts.put(chartUrl, new Response('chart', { headers: {
    'content-length': '5', [VERIFIED_SHA256_HEADER]: 'a'.repeat(64),
  } }));
  onFetch({ request: new Request(chartUrl), respondWith: work => { response = work; }, waitUntil: () => {} });
  assert.equal(await (await response).text(), 'chart', 'the worker holds a resident chart before reset');
  onFetch({ request: new Request('https://app.test/weather/pending.json'), respondWith: work => { response = work; },
    waitUntil: () => {} });
  await started;
  let acknowledged = false, stopped!: Promise<unknown>, ready!: () => void;
  const prepared = new Promise<void>(resolve => { ready = resolve; });
  onMessage({ data: { type: 'reset-screen-ready' }, source: client, ports: [], waitUntil: () => {} });
  onMessage({ data: { type: 'prepare-reset', navigateWindows: true }, source: client,
    ports: [{ postMessage: value => { assert.deepEqual(value, { ok: true }); acknowledged = true; ready(); } }],
    waitUntil: work => { stopped = work; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(acknowledged, false, 'deletion must wait for already-running fetch/cache writes');
  finishFetch(Response.json({ saved: true }));
  await response;
  await prepared;
  assert.equal(acknowledged, true);
  assert.equal(stored.size, 1);
  stored.clear(); // The reset screen can now delete storage.
  await charts.delete(chartUrl);
  onFetch({ request: new Request('https://app.test/weather/later.json'), respondWith: work => { response = work; },
    waitUntil: () => {} });
  await response;
  assert.equal(stored.size, 0, 'a stopped worker must not recreate deleted data');
  onMessage({ data: { type: 'finish-reset' }, source: client,
    ports: [{ postMessage: value => assert.deepEqual(value, { ok: true }) }], waitUntil: () => {} });
  await stopped;
  // Re-registering can revive the same worker after reinstalling its app shell.
  await (await caches.open('zlayers-shell-dev')).put('https://app.test/', new Response(shellHtml));
  let revived!: Promise<unknown>, revivalReply: unknown;
  onMessage({ data: { type: 'prepare-pwa' }, source: { ...client, url: 'https://app.test/' },
    ports: [{ postMessage: value => { revivalReply = value; } }],
    waitUntil: work => { revived = work; } });
  await revived;
  assert.deepEqual(revivalReply, { ok: true });
  fetch.mock.mockImplementation(async () => { throw new TypeError('offline'); });
  onFetch({ request: new Request(chartUrl), respondWith: work => { response = work; }, waitUntil: () => {} });
  assert.equal((await response).status, 503, 'a revived worker cannot serve charts from before the reset');
  assert.equal(await charts.match(chartUrl), undefined);
});

test('reset waits for a navigated screen even while client enumeration omits it', async t => {
  const { client, clients, onMessage } = await workerFixture(t);
  const loading = { id: 'loading-screen', url: client.url };
  let navigated = false;
  clients.matchAll = async () => navigated ? [client] : [client, {
    id: 'workspace', url: 'https://app.test/', navigate: async () => { navigated = true; return loading; },
  }];
  onMessage({ data: { type: 'reset-screen-ready' }, source: client, ports: [], waitUntil: () => {} });
  let acknowledged = false, stopped!: Promise<unknown>, ready!: () => void;
  const prepared = new Promise<void>(resolve => { ready = resolve; });
  onMessage({ data: { type: 'prepare-reset', navigateWindows: true }, source: client,
    ports: [{ postMessage: value => { assert.deepEqual(value, { ok: true }); acknowledged = true; ready(); } }],
    waitUntil: work => { stopped = work; } });
  t.after(() => onMessage({ data: { type: 'finish-reset' }, source: client,
    ports: [{ postMessage: () => {} }], waitUntil: () => {} }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(navigated, true);
  assert.equal(acknowledged, false, 'loading screens still need the shell even if matchAll omits them');
  onMessage({ data: { type: 'reset-screen-ready' }, source: loading, ports: [], waitUntil: () => {} });
  await prepared;
  onMessage({ data: { type: 'finish-reset' }, source: client,
    ports: [{ postMessage: () => {} }], waitUntil: () => {} });
  await stopped;
});

test('additional workers wait for the coordinator without navigating windows again', async t => {
  const { client, clients, onMessage } = await workerFixture(t);
  const other = { id: 'other', url: 'https://app.test/', navigate: async () => {
    assert.fail('only the coordinator may navigate windows');
  } };
  clients.matchAll = async () => [client, other];
  onMessage({ data: { type: 'reset-screen-ready' }, source: client, ports: [], waitUntil: () => {} });
  let acknowledged = false, stopped!: Promise<unknown>, ready!: () => void;
  const prepared = new Promise<void>(resolve => { ready = resolve; });
  onMessage({ data: { type: 'prepare-reset', navigateWindows: false }, source: client,
    ports: [{ postMessage: value => { assert.deepEqual(value, { ok: true }); acknowledged = true; ready(); } }],
    waitUntil: work => { stopped = work; } });
  t.after(() => onMessage({ data: { type: 'finish-reset' }, source: client,
    ports: [{ postMessage: () => {} }], waitUntil: () => {} }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(acknowledged, false);
  const loaded = { id: 'other-reset', url: client.url };
  clients.matchAll = async () => [client, loaded];
  onMessage({ data: { type: 'reset-screen-ready' }, source: loaded, ports: [], waitUntil: () => {} });
  await prepared;
  onMessage({ data: { type: 'finish-reset' }, source: client,
    ports: [{ postMessage: () => {} }], waitUntil: () => {} });
  await stopped;
});

test('concurrent PWA preparations acknowledge a rebuilt shell and report failures', async t => {
  const { client, clients, onMessage, onFetch } = await workerFixture(t);
  const shell = await caches.open('zlayers-shell-dev');
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(shellHtml));
  let finish!: () => void, builds = 0, claimed = false;
  const rebuilding = new Promise<void>(resolve => { finish = resolve; });
  Object.assign(shell, { addAll: async () => { builds++; await rebuilding; } });
  clients.claim = async () => { claimed = true; };
  const replies: unknown[] = [];
  const prepare = () => {
    let work!: Promise<unknown>;
    onMessage({ data: { type: 'prepare-pwa' }, source: { ...client, url: 'https://app.test/' },
      ports: [{ postMessage: value => { replies.push(value); } }], waitUntil: pending => { work = pending; } });
    return work;
  };
  const first = prepare(), second = prepare();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(builds, 1, 'windows share one shell rebuild');
  assert.equal(claimed, false);
  assert.deepEqual(replies, []);
  assert.equal(await shell.match('https://app.test/'), undefined, 'the page waits for the complete shell');
  finish();
  await Promise.all([first, second]);
  assert.equal(claimed, true);
  assert.deepEqual(replies, [{ ok: true }, { ok: true }]);
  assert.equal(await (await shell.match('https://app.test/'))?.text(), shellHtml);

  // A saved page skips rebuilding; remove it to exercise a failed repair.
  await shell.delete('https://app.test/');
  Object.assign(shell, { addAll: async () => { throw new Error('offline'); } });
  await prepare();
  assert.deepEqual(replies.at(-1), { error: 'Offline worker could not prepare storage' });
  assert.equal(await shell.match('https://app.test/'), undefined);
  // A failed preparation can retry, and successful readiness permits durable writes.
  Object.assign(shell, { addAll: async () => {} });
  await prepare();
  assert.deepEqual(replies.at(-1), { ok: true });
  fetch.mock.mockImplementation(async () => new Response('weather'));
  let response!: Promise<Response>;
  const url = 'https://app.test/weather/ready.json';
  onFetch({ request: new Request(url), respondWith: work => { response = work; }, waitUntil: () => {} });
  await response;
  assert.equal(await (await caches.match(url))?.text(), 'weather');
});
