import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { cacheFixture } from './helpers/cache';
import { CHART_CACHE, VERIFIED_SHA256_HEADER } from '../src/core/storage/cache-names';

const shellHtml = '<meta name="zlayer-release" content="dev">';

test('About requests bypass the worker while existing app navigation remains available offline', async t => {
  const { onFetch } = await workerFixture(t);
  await (await caches.open('zlayers-shell-dev')).put('https://app.test/', new Response(shellHtml));
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('offline'); });
  for (const path of ['/about', '/about/', '/about/?reset=1', '/about/index.html', '/about/workspace.webp', '/about/missing']) {
    for (const navigate of [false, true]) {
      const request = new Request(`https://app.test${path}`);
      if (navigate) Object.defineProperty(request, 'mode', { value: 'navigate' });
      onFetch({ request,
        respondWith: () => assert.fail(`${path} must use the browser's network response`),
        waitUntil: () => assert.fail(`${path} must not schedule worker cache work`) });
    }
  }
  const pending: Promise<unknown>[] = [];
  for (const path of ['/', '/?reset=1', '/index.html', '/aboutness', '/legacy-workspace', '/icon.svg']) {
    const request = new Request(`https://app.test${path}`);
    Object.defineProperty(request, 'mode', { value: 'navigate' });
    let response: Promise<Response> | undefined;
    onFetch({ request, respondWith: work => { response = work; }, waitUntil: work => { pending.push(work); } });
    assert(response, `${path} retains the existing app-shell fallback`);
    assert.equal(await (await response).text(), shellHtml);
  }
  await Promise.all(pending);
  assert.equal(network.mock.callCount(), 0, 'offline app navigation needs no network response');
});

test('offline navigation can use a retained complete release without accepting an incomplete or mismatched shell', async t => {
  const { onFetch } = await workerFixture(t);
  const oldVersion = 'a'.repeat(16), partialVersion = 'b'.repeat(16);
  const oldHtml = `<meta name="zlayer-release" content="${oldVersion}"><script src="/assets/old.js"></script>`;
  const oldCache = await caches.open(`zlayers-shell-${oldVersion}`);
  await oldCache.put('https://app.test/', new Response(oldHtml));
  await oldCache.put('https://app.test/assets/old.js', new Response('old workspace'));
  await (await caches.open(`zlayers-shell-${partialVersion}`)).put('https://app.test/', new Response(shellHtml));
  await (await caches.open('zlayers-shell-dev')).put('https://app.test/', new Response('wrong current release'));
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('offline'); });
  const read = (path: string) => {
    let response!: Promise<Response>;
    onFetch({ request: new Request(`https://app.test${path}`), respondWith: work => { response = work; }, waitUntil: () => {} });
    return response;
  };
  assert.equal(await (await read('/')).text(), oldHtml);
  assert.equal(await (await read('/assets/old.js')).text(), 'old workspace');
  assert.equal(network.mock.callCount(), 0);
  await oldCache.delete('https://app.test/');
  await assert.rejects(read('/'), /offline/, 'a mismatched page cannot serve as a completed fallback');
});

test('legacy and explicit full preparation use a retained shell while one background repair stays alive', async t => {
  const { client, clients, onMessage } = await workerFixture(t);
  const origin = 'https://app.test/', version = 'a'.repeat(16);
  const retained = await caches.open(`zlayers-shell-${version}`);
  await retained.put(origin, new Response(`<meta name="zlayer-release" content="${version}">`));
  const current = await caches.open('zlayers-shell-dev');
  Object.assign(current, { addAll: async () => {} });
  const claim = t.mock.method(clients, 'claim', async () => {});
  let finish!: (response: Response) => void;
  const fetch = t.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => { finish = resolve; }));
  const lifetime: Promise<unknown>[] = [];
  const message = (data: unknown) => new Promise(resolve => {
    onMessage({ data, source: { ...client, url: origin }, ports: [{ postMessage: resolve }],
      waitUntil: work => { lifetime.push(work); } });
  });
  // Before separate chart readiness, both reads and downloads sent this message.
  assert.deepEqual(await message({ type: 'prepare-pwa' }), { ok: true });
  assert.deepEqual(await message({ type: 'prepare-pwa', requireShell: true }), { ok: true });
  assert.equal(claim.mock.callCount(), 2);
  assert.equal(fetch.mock.callCount(), 1, 'repeated preparations share the pending repair');
  assert.equal(await current.match(origin), undefined, 'readiness does not commit the active release');
  assert.deepEqual(await message({ type: 'app-release' }), { error: 'Application shell is not ready' });
  let settled = false;
  const pending = Promise.all(lifetime).then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'the repair stays in the initiating message lifetime after acknowledgement');
  finish(new Response(shellHtml));
  await pending;
  assert.equal(await (await current.match(origin))?.text(), shellHtml);
  assert.deepEqual(await message({ type: 'app-release' }), { release: 'dev', displayVersion: 'dev', resetAdvisory: null });

  await current.delete(origin);
  fetch.mock.mockImplementation(async () => { throw new TypeError('offline'); });
  assert.deepEqual(await message({ type: 'prepare-pwa' }), { ok: true }, 'failed repair preserves retained readiness');
  await Promise.all(lifetime);
  await retained.put(origin, new Response(shellHtml));
  for (const requireShell of [undefined, true]) {
    assert.deepEqual(await message({ type: 'prepare-pwa', ...(requireShell === undefined ? {} : { requireShell }) }),
      { error: 'Offline worker could not prepare storage' }, 'a mismatched retained page cannot authorize full readiness');
  }
  await Promise.all(lifetime);
});

test('non-root windows retain old shells until the reporting app is the only window', async t => {
  const { client, clients, onMessage } = await workerFixture(t);
  const app = { ...client, url: 'https://app.test/' };
  await (await caches.open('zlayers-shell-dev')).put(app.url, new Response(`${shellHtml}<script src="/assets/app-current.js"></script>`));
  await (await caches.open('zlayers-shell-old')).put(app.url, new Response('<script src="/assets/app-old.js"></script>'));
  const report = async () => {
    let work!: Promise<unknown>;
    onMessage({ data: { type: 'active-shell', entry: 'https://app.test/assets/app-current.js' }, source: app,
      ports: [], waitUntil: pending => { work = pending; } });
    await work;
  };
  for (const path of ['/about/', '/legacy-workspace']) {
    clients.matchAll = async () => [app, { id: 'older-window', url: `https://app.test${path}` }];
    await report();
    assert((await caches.keys()).includes('zlayers-shell-old'), `${path} may still run an older app`);
  }
  clients.matchAll = async () => [app];
  await report();
  assert(!(await caches.keys()).includes('zlayers-shell-old'), 'cleanup resumes after the other window closes');
});

test('archive failure and verified recovery are ordered, coalesced and kept in the worker lifetime', async t => {
  const { onFetch, onMessage, clients, client } = await workerFixture(t);
  const messages: Array<{ type: string; url: string }> = [];
  t.mock.method(client, 'postMessage', (message: { type: string; url: string }) => { messages.push(message); });
  let release!: () => void;
  const enumeration = new Promise<void>(resolve => { release = resolve; });
  let enumerations = 0;
  t.mock.method(clients, 'matchAll', async () => { if (++enumerations === 1) await enumeration; return [client]; });
  const pending: Promise<unknown>[] = [];
  const url = `https://charts.tedyin.com/charts/ifr.mbtiles?bytes=3&sha256=${'a'.repeat(64)}`;
  const read = (range?: string) => {
    let result!: Promise<Response>;
    onFetch({ request: new Request(url, range ? { headers: { range } } : {}), respondWith: work => { result = work; },
      waitUntil: work => { pending.push(work); } });
    return result;
  };
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  assert.deepEqual(await Promise.all([read(), read()].map(async work => (await work).status)), [503, 503]);
  await (await caches.open(CHART_CACHE)).put(url, new Response('ifr', { headers: {
    'content-length': '3', [VERIFIED_SHA256_HEADER]: 'a'.repeat(64),
  } }));
  assert.equal((await read()).status, 200, 'notification delivery must not delay a usable response');
  assert.deepEqual(messages, [], 'late failure enumeration holds recovery delivery in order');
  release();
  await Promise.all(pending);
  assert.deepEqual(messages.map(({ type, url }) => ({ type, url })), [
    { type: 'chart-archive-error', url }, { type: 'chart-archive-ready', url },
  ]);
  assert.equal((await read('bytes=0-1')).status, 206);
  await Promise.all(pending);
  assert.equal(messages.length, 2, 'resident range reads must not broadcast repeatedly');
  onMessage({ data: { type: 'forget-chart-memory', url }, source: client, ports: [], waitUntil: () => {} });
  assert.equal((await read('bytes=1-2')).status, 206);
  await Promise.all(pending);
  assert.equal(messages.length, 2, 'reopening a healthy nonresident archive must not rebroadcast readiness');
});

test('large chart downloads without writable storage return an actionable error and cancel the body', async t => {
  const { onFetch } = await workerFixture(t);
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  })));
  const url = `https://charts.tedyin.com/charts/large.mbtiles?bytes=${20 * 1024 * 1024}&sha256=${'a'.repeat(64)}`;
  let result!: Promise<Response>;
  onFetch({ request: new Request(url, { method: 'HEAD' }), respondWith: work => { result = work; }, waitUntil: () => {} });
  const response = await result;
  assert.equal(response.status, 507);
  assert.equal(response.headers.get('x-zlayer-error-code'), 'storage');
  assert.match(response.headers.get('x-zlayer-error')!, /local file storage/);
  assert.equal(cancelled, true);
});

async function workerFixture(t: TestContext) {
  const { cache, stored } = cacheFixture(t);
  type Message = { data: unknown; source: { id: string; url: string }; ports: { postMessage: (value: unknown) => void }[];
    waitUntil: (work: Promise<unknown>) => void };
  type Fetch = { request: Request; respondWith: (response: Promise<Response>) => void; waitUntil: (work: Promise<unknown>) => void };
  let onMessage!: (event: Message) => void, onFetch!: (event: Fetch) => void;
  const client = { id: 'reset-screen', url: 'https://app.test/?reset=1', postMessage: () => {} };
  let activations = 0;
  const original = Object.getOwnPropertyDescriptor(globalThis, 'self');
  const clients = { matchAll: async (): Promise<{ id: string; url: string; navigate?: (url: string) => Promise<unknown> }[]> => [client],
    claim: async () => {} };
  Object.defineProperty(globalThis, 'self', { configurable: true, value: Object.assign(Object.create(globalThis), {
    location: { pathname: '/sw.js', origin: 'https://app.test' },
    registration: { active: {}, installing: null, waiting: null },
    clients,
    skipWaiting: async () => { activations++; },
    addEventListener(type: string, listener: never) {
      if (type === 'fetch') onFetch = listener;
      if (type === 'message') onMessage = listener;
    },
  }) });
  t.after(() => original ? Object.defineProperty(globalThis, 'self', original) : Reflect.deleteProperty(globalThis, 'self'));
  await import(`../src/service-worker.ts?test=${encodeURIComponent(t.name)}`);
  return { cache, stored, client, clients, activations: () => activations,
    onMessage: (event: Message) => onMessage(event), onFetch: (event: Fetch) => onFetch(event) };
}

test('reset drains worker writes, prevents new writes, and discards resident charts before revival', async t => {
  const { stored, client, clients, onMessage, onFetch } = await workerFixture(t);
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
  onFetch({ request: new Request('https://charts.tedyin.com/charts/pending.json'), respondWith: work => { response = work; },
    waitUntil: () => {} });
  await started;
  let claimed!: () => void, preparing!: Promise<unknown>, pendingReply: unknown;
  const claim = t.mock.method(clients, 'claim', () => new Promise<void>(resolve => { claimed = resolve; }));
  onMessage({ data: { type: 'prepare-pwa', requireShell: false }, source: { ...client, url: 'https://app.test/' },
    ports: [{ postMessage: value => { pendingReply = value; } }], waitUntil: work => { preparing = work; } });
  let acknowledged = false, stopped!: Promise<unknown>, ready!: () => void;
  const prepared = new Promise<void>(resolve => { ready = resolve; });
  onMessage({ data: { type: 'reset-screen-ready' }, source: client, ports: [], waitUntil: () => {} });
  onMessage({ data: { type: 'prepare-reset', navigateWindows: true }, source: client,
    ports: [{ postMessage: value => { assert.deepEqual(value, { ok: true }); acknowledged = true; ready(); } }],
    waitUntil: work => { stopped = work; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(acknowledged, false, 'deletion must wait for already-running fetch/cache writes');
  claimed(); await preparing;
  assert.deepEqual(pendingReply, { error: 'Offline worker could not prepare storage' },
    'a reset starting during preparation must not acknowledge usable chart storage');
  claim.mock.restore();
  finishFetch(Response.json({ saved: true }));
  await response;
  await prepared;
  assert.equal(acknowledged, true);
  let check!: Promise<unknown>, chartReply: unknown;
  onMessage({ data: { type: 'prepare-pwa', requireShell: false }, source: { ...client, url: 'https://app.test/' },
    ports: [{ postMessage: value => { chartReply = value; } }], waitUntil: work => { check = work; } });
  await check;
  assert.deepEqual(chartReply, { error: 'Offline worker could not prepare storage' }, 'saved-chart preparation cannot bypass reset');
  onFetch({ request: new Request('https://app.test/about/'),
    respondWith: () => assert.fail('About also bypasses worker caching during reset'),
    waitUntil: () => assert.fail('About must not add work to the reset handshake') });
  assert.equal(stored.size, 1);
  stored.clear(); // The reset screen can now delete storage.
  await charts.delete(chartUrl);
  onFetch({ request: new Request('https://charts.tedyin.com/charts/later.json'), respondWith: work => { response = work; },
    waitUntil: () => {} });
  await response;
  assert.equal(stored.size, 0, 'a stopped worker must not recreate deleted data');
  onMessage({ data: { type: 'finish-reset' }, source: client,
    ports: [{ postMessage: value => assert.deepEqual(value, { ok: true }) }], waitUntil: () => {} });
  await stopped;
  // Even a surviving complete retained shell cannot bypass rebuilding after reset.
  const retainedVersion = 'a'.repeat(16);
  await (await caches.open(`zlayers-shell-${retainedVersion}`)).put('https://app.test/',
    new Response(`<meta name="zlayer-release" content="${retainedVersion}">`));
  fetch.mock.mockImplementation(async () => { throw new TypeError('offline'); });
  for (const requireShell of [undefined, true, false]) {
    let blocked!: Promise<unknown>, reply: unknown;
    onMessage({ data: { type: 'prepare-pwa', ...(requireShell === undefined ? {} : { requireShell }) },
      source: { ...client, url: 'https://app.test/' }, ports: [{ postMessage: value => { reply = value; } }],
      waitUntil: work => { blocked = work; } });
    await blocked;
    assert.deepEqual(reply, { error: 'Offline worker could not prepare storage' });
  }
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

test('reset includes a non-root window and waits even while client enumeration omits its screen', async t => {
  const { client, clients, onMessage } = await workerFixture(t);
  const loading = { id: 'loading-screen', url: client.url };
  let navigated = false;
  clients.matchAll = async () => navigated ? [client] : [client, {
    id: 'workspace', url: 'https://app.test/about/', navigate: async () => { navigated = true; return loading; },
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
  const other = { id: 'other', url: 'https://app.test/legacy-workspace', navigate: async () => {
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
  let chartCheck!: Promise<unknown>, chartReply: unknown;
  onMessage({ data: { type: 'prepare-pwa', requireShell: false }, source: { ...client, url: 'https://app.test/' },
    ports: [{ postMessage: value => { chartReply = value; } }], waitUntil: work => { chartCheck = work; } });
  await chartCheck;
  assert.deepEqual(chartReply, { ok: true }, 'a pending shell repair does not block existing chart storage');
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
  const url = 'https://charts.tedyin.com/charts/ready.json';
  onFetch({ request: new Request(url), respondWith: work => { response = work; }, waitUntil: () => {} });
  await response;
  assert.equal(await (await caches.match(url))?.text(), 'weather');
});

test('saved-chart reads still work when offline shell repair fails', async t => {
  const { client, onMessage, onFetch } = await workerFixture(t);
  const url = `https://charts.tedyin.com/charts/saved.mbtiles?bytes=5&sha256=${'c'.repeat(64)}`;
  await (await caches.open(CHART_CACHE)).put(url, new Response('chart', { headers: {
    'content-length': '5', [VERIFIED_SHA256_HEADER]: 'c'.repeat(64),
  } }));
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('offline'); });
  for (const requireShell of [true, false]) {
    let check!: Promise<unknown>, reply: unknown;
    onMessage({ data: { type: 'prepare-pwa', requireShell }, source: { ...client, url: 'https://app.test/' },
      ports: [{ postMessage: value => { reply = value; } }], waitUntil: work => { check = work; } });
    await check;
    assert.deepEqual(reply, requireShell ? { error: 'Offline worker could not prepare storage' } : { ok: true });
  }
  let response!: Promise<Response>;
  onFetch({ request: new Request(url), respondWith: work => { response = work; }, waitUntil: () => {} });
  assert.equal(await (await response).text(), 'chart');
});

test('waiting-worker recovery activates only a complete matching shell', async t => {
  const { onMessage, activations } = await workerFixture(t);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  const cache = await caches.open('zlayers-shell-dev');
  const activate = () => {
    let work!: Promise<unknown>;
    onMessage({ data: { type: 'activate-update' }, source: { id: 'app', url: 'https://app.test/' },
      ports: [], waitUntil: value => { work = value; } });
    return work;
  };
  await assert.rejects(activate(), /shell is not ready/);
  await cache.put('https://app.test/', new Response('<meta name="zlayer-release" content="wrong">'));
  await assert.rejects(activate(), /shell is not ready/);
  assert.equal(activations(), 0);
  await cache.put('https://app.test/', new Response(shellHtml));
  await activate();
  assert.equal(activations(), 1);
  assert.equal(await (await cache.match('https://app.test/'))?.text(), shellHtml);
});

test('release inspection cannot offer a missing or mismatched shell as an offline update', async t => {
  const { client, onMessage } = await workerFixture(t);
  const cache = await caches.open('zlayers-shell-dev');
  const inspect = async () => {
    let work!: Promise<unknown>, reply: unknown;
    onMessage({ data: { type: 'app-release' }, source: { ...client, url: 'https://app.test/' },
      ports: [{ postMessage: value => { reply = value; } }], waitUntil: value => { work = value; } });
    await work;
    return reply;
  };
  assert.deepEqual(await inspect(), { error: 'Application shell is not ready' });
  await cache.put('https://app.test/', new Response('<meta name="zlayer-release" content="wrong">'));
  assert.deepEqual(await inspect(), { error: 'Application shell is not ready' });
  await cache.put('https://app.test/', new Response(shellHtml));
  assert.deepEqual(await inspect(), { release: 'dev', displayVersion: 'dev', resetAdvisory: null });
  await cache.delete('https://app.test/');
  assert.deepEqual(await inspect(), { error: 'Application shell is not ready' });
});
