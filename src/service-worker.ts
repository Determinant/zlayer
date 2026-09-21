/// <reference lib="webworker" />

import { WholeFileChartCache, type ChartArchive } from './layers/charts/worker';
import { isOnChartFeed } from './workspace/catalog/feed';
import { CHART_CACHE, DATA_CACHE } from './core/storage/cache-names';
import { noteCacheAccess } from './core/storage/cache-access';
import { pruneShellCaches, SHELL_CACHE_PREFIX } from './core/storage/shell-cache';
import { resourceErrorCode } from './core/data/errors';
import { RESET_URL } from './core/storage/reset';

const worker = self as unknown as ServiceWorkerGlobalScope;
const development = worker.location.pathname.startsWith('/src/');
// Keep the historical namespace so the ZLayer rename preserves stored downloads.
const embeddedShell = '__ZLAYER_OFFLINE_SHELL__';
const shellDefinition: { version: string; displayVersion: string; assets: string[] } = embeddedShell.startsWith('{')
  ? JSON.parse(embeddedShell) : { version: 'dev', displayVersion: 'dev', assets: [] };
const shellCache = `${SHELL_CACHE_PREFIX}${shellDefinition.version}`;
const shellPageUrl = `${worker.location.origin}/`;
// Runtime data survives ordinary application-shell releases.
const dataCache = DATA_CACHE;
const chartArchiveCachePrefix = 'zlayers-chart-archives-';
const chartArchiveCache = CHART_CACHE;
let chartArchives = new WholeFileChartCache();
let resetting = false;
let resetComplete = false;
const resetHolds = new Set<() => void>();
const pendingWork = new Set<Promise<unknown>>();
const resetScreens = new Set<string>();
let preparingPwa: Promise<void> | undefined;

function trackWork<T>(work: Promise<T>): Promise<T> {
  pendingWork.add(work);
  void work.then(() => pendingWork.delete(work), () => pendingWork.delete(work));
  return work;
}

worker.addEventListener('install', (event) => {
  event.waitUntil(
    trackWork((development ? Promise.resolve() : cacheApplicationShell())
      .then(() => worker.skipWaiting())),
  );
});

worker.addEventListener('activate', (event) => {
  if (resetting) return;
  event.waitUntil(
    trackWork(caches
      .keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) =>
            // Open tabs may still import a previous release's lazy chunks.
            // Keep those shells; chart/PDF downloads survive app updates as well.
            (key.startsWith(chartArchiveCachePrefix) && key !== chartArchiveCache)
          )
          .map((key) => caches.delete(key)),
      ))
      .then(() => worker.clients.claim())),
  );
});

worker.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const sameOrigin = url.origin === worker.location.origin;
  const applicationPage = !development && event.request.method === 'GET' &&
    (event.request.mode === 'navigate' || (sameOrigin && url.pathname === '/'));
  if (resetting) {
    // Reset screens still need the installed shell while offline. No new writes
    // may start after the reset handshake, including stale-while-revalidate work.
    event.respondWith(applicationPage
      ? applicationPageResponse(event.request)
      : (async () => (await caches.match(event.request)) ?? fetch(event.request))());
    return;
  }
  const respond = (response: Promise<Response>) => event.respondWith(trackWork(response));
  const onChartFeed = isOnChartFeed(url, `${worker.location.origin}/`);

  if (onChartFeed && /\.(mbtiles|dem|terrain)$/.test(url.pathname) && ['GET', 'HEAD'].includes(event.request.method)) {
    respond(chartArchiveResponse(event.request));
    return;
  }
  // Weather products own their persistent caches and must see actual refresh failures,
  // including when browser cache settings override the request's cache mode.
  if (event.request.cache === 'no-store' || (sameOrigin &&
    ['/weather/metars.geojson', '/weather/tafs.json'].includes(url.pathname))) return;

  // The page validates/revalidates navigation manifests and owns their offline
  // fallback. Cache-mode overrides must not replay an older same-cycle build.
  if (onChartFeed && url.pathname.endsWith('/nav/manifest.json')) return;

  if (event.request.method !== 'GET') return;

  if (applicationPage) {
    respond(applicationPageResponse(new Request(shellPageUrl)));
    return;
  }

  if (!development && sameOrigin && url.pathname.startsWith('/assets/')) {
    respond(shellAssetResponse(event.request));
    return;
  }

  if (!development && sameOrigin && shellDefinition.assets.includes(url.pathname)) {
    respond(cacheFirst(new Request(`${url.origin}${url.pathname}`), shellCache));
    return;
  }

  if (sameOrigin && url.pathname.startsWith('/weather/')) {
    respond(networkFirst(event.request, dataCache));
    return;
  }

  if (onChartFeed && !url.pathname.toLowerCase().endsWith('.pdf')) {
    // Honor catalog revalidation, including navigation and procedure manifests.
    if (isChartManifest(url.pathname) || event.request.cache === 'no-cache') {
      respond(networkFirst(event.request, dataCache));
    } else if (isMutableDataDocument(url.pathname)) {
      respond(staleWhileRevalidate(event, dataCache));
    } else {
      respond(cacheFirst(event.request, dataCache));
    }
    return;
  }

  if (sameOrigin && isMutableDataDocument(url.pathname)) {
    respond(staleWhileRevalidate(event, dataCache));
    return;
  }

  // Plates owns full-document validation and caching, including in development.
  // Do not populate that cache with an unverified PDF.js range/stream response.

  if (
    url.hostname === 'demotiles.maplibre.org' ||
    url.hostname === 'tiles.openfreemap.org' ||
    url.hostname === 'basemap.nationalmap.gov'
  ) {
    respond(cacheFirst(event.request, dataCache));
  }
});

worker.addEventListener('message', (event) => {
  if (isRecord(event.data) && event.data.type === 'finish-reset' && event.source && 'url' in event.source &&
    event.source.url === new URL(RESET_URL, worker.location.origin).href && event.ports[0]) {
    resetComplete = true;
    for (const release of resetHolds) release();
    event.ports[0].postMessage({ ok: true });
    return;
  }
  if (isRecord(event.data) && event.data.type === 'prepare-pwa' && event.source && 'url' in event.source &&
    new URL(event.source.url).origin === worker.location.origin &&
    new URL(event.source.url).searchParams.get('reset') !== '1') {
    preparingPwa ??= trackWork(prepareApplication().finally(() => { preparingPwa = undefined; }));
    event.waitUntil(preparingPwa.then(
      () => event.ports[0]?.postMessage({ ok: true }),
      () => event.ports[0]?.postMessage({ error: 'Offline worker could not prepare storage' }),
    ));
    return;
  }
  if (isRecord(event.data) && event.data.type === 'reset-screen-ready' && event.source && 'id' in event.source &&
    event.source.url === new URL(RESET_URL, worker.location.origin).href) {
    resetScreens.add(event.source.id);
    return;
  }
  if (isRecord(event.data) && event.data.type === 'prepare-reset' && event.source && 'url' in event.source &&
    event.source.url === new URL(RESET_URL, worker.location.origin).href && event.ports[0]) {
    event.waitUntil(prepareReset(event.data.navigateWindows === true).then(async () => {
      // Keep the worker's read-only mode alive while the page deletes storage.
      const held = holdReset();
      event.ports[0]!.postMessage({ ok: true });
      await held;
    }, error => {
      event.ports[0]!.postMessage({ error: error instanceof Error ? error.message : 'Could not stop open workspaces' });
    }));
    return;
  }
  if (resetting) return;
  if (isRecord(event.data) && event.data.type === 'app-release') {
    // Preserve the opaque ID so already-open older clients can still offer this update.
    event.ports[0]?.postMessage({ release: shellDefinition.version, displayVersion: shellDefinition.displayVersion });
    return;
  }
  if (isRecord(event.data) && event.data.type === 'forget-chart-memory' && typeof event.data.url === 'string') {
    chartArchives.forget(event.data.url);
    return;
  }
  if (!development && isRecord(event.data) && event.data.type === 'active-shell' &&
    typeof event.data.entry === 'string' && event.source && 'id' in event.source) {
    const entry = new URL(event.data.entry, worker.location.origin);
    if (entry.origin !== worker.location.origin || !entry.pathname.startsWith('/assets/')) return;
    const clientId = event.source.id;
    const active = worker.registration.active;
    const canPrune = () => !resetting && worker.registration.active === active &&
      !worker.registration.installing && !worker.registration.waiting;
    event.waitUntil(trackWork(worker.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clients => {
      // Keep every release while other windows might need their lazy chunks.
      if (clients.length === 1 && clients[0]?.id === clientId) {
        await pruneShellCaches(shellCache, entry.href, worker.location.origin, canPrune);
      }
    }).catch(() => {})));
  }
});

function holdReset(): Promise<void> {
  return new Promise(resolve => {
    const release = () => { clearTimeout(timeout); resetHolds.delete(release); resolve(); };
    const timeout = setTimeout(release, 180_000);
    resetHolds.add(release);
  });
}

async function prepareReset(navigateWindows: boolean): Promise<void> {
  resetting = true;
  resetComplete = false;
  const target = new URL(RESET_URL, worker.location.origin).href;
  const clients = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const screens = navigateWindows ? await Promise.all(clients.map(async client => {
    if (client.url === target) return client;
    // Navigation destroys page workers and pending persistence callbacks too.
    const screen = await client.navigate(target);
    if (!screen) throw new Error('Close other ZLayer windows, then retry the reset.');
    return screen;
  })) : [];
  const deadline = Date.now() + 15_000;
  // Loading documents can temporarily disappear from matchAll. Keep the clients
  // we navigated until each confirms its code and styles have loaded.
  while (screens.some(client => !resetScreens.has(client.id)) ||
    (await worker.clients.matchAll({ type: 'window', includeUncontrolled: true }))
    .some(client => client.url !== target || !resetScreens.has(client.id))) {
    if (Date.now() >= deadline) throw new Error('Close other ZLayer windows, then retry the reset.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  while (pendingWork.size) await Promise.allSettled([...pendingWork]);
  // A later registration can revive this worker. Discard resident blobs too,
  // after all downloads have settled so none can repopulate the old instance.
  chartArchives = new WholeFileChartCache();
}

async function prepareApplication(): Promise<void> {
  const checkReset = () => {
    if (resetting && !resetComplete) throw new Error('Local data reset is in progress');
  };
  checkReset();
  // A revived registration need not install again, and worker memory can be lost.
  if (!development && !await cachedApplicationPage()) {
    await cacheApplicationShell();
  }
  checkReset(); // A reset may have started while the shell was being rebuilt.
  resetting = false;
  resetComplete = false;
  await worker.clients.claim();
}

async function cacheApplicationShell(): Promise<void> {
  const cache = await caches.open(shellCache);
  // Repair a rejected/legacy page without discarding a valid previous shell.
  if (!await cachedApplicationPage()) await cache.delete(shellPageUrl);
  const page = await fetch(new Request(shellPageUrl, { cache: 'reload' }));
  // A deploy/CDN can switch HTML while this worker downloads its shell.
  // Validate before writing, then commit the page only after every asset is saved.
  if (!await matchesApplicationRelease(page)) {
    throw new Error('Application page and service worker releases do not match');
  }
  await cache.addAll(shellDefinition.assets.filter(url => url !== '/')
    .map(url => new Request(url, { cache: 'reload' })));
  await cache.put(shellPageUrl, page);
}

async function matchesApplicationRelease(page: Response): Promise<boolean> {
  return page.ok && (await page.clone().text()).includes(`<meta name="zlayer-release" content="${shellDefinition.version}"`);
}

async function cachedApplicationPage(): Promise<Response | undefined> {
  const page = await caches.match(shellPageUrl, { cacheName: shellCache });
  return page && await matchesApplicationRelease(page) ? page : undefined;
}

async function applicationPageResponse(request: Request): Promise<Response> {
  // Only a complete shell download may cache the page: navigation alone cannot
  // establish offline readiness or place a newer release in this worker's cache.
  return (await cachedApplicationPage()) ?? fetch(request);
}

async function shellAssetResponse(request: Request): Promise<Response> {
  return (await caches.match(request)) ?? cacheFirst(request, shellCache);
}

async function cacheFirst(request: Request, cacheName: string): Promise<Response> {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.status === 200 || response.type === 'opaque') {
    await cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}

async function networkFirst(
  request: Request,
  cacheName: string,
): Promise<Response> {
  const cache = await caches.open(cacheName);
  if (worker.navigator?.onLine === false) return (await cache.match(request)) ?? Response.error();
  try {
    const response = await fetch(request, { signal: AbortSignal.timeout(8_000) });
    if (response.ok) {
      await cache.put(request, response.clone()).catch(() => {});
      return response;
    }
    return (await cache.match(request)) ?? response;
  } catch {
    return (await cache.match(request)) ?? Response.error();
  }
}

async function staleWhileRevalidate(
  event: FetchEvent,
  cacheName: string,
): Promise<Response> {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(event.request);
  const update = fetch(event.request).then(async (response) => {
    if (response.ok) await cache.put(event.request, response.clone()).catch(() => {});
    return response;
  });
  if (cached) {
    event.waitUntil(trackWork(update.then(() => undefined).catch(() => undefined)));
    return cached;
  }
  try {
    return await update;
  } catch {
    return Response.error();
  }
}

function isMutableDataDocument(pathname: string): boolean {
  return pathname.endsWith('/current.json') ||
    pathname.endsWith('/manifest.json') ||
    pathname.endsWith('/chart-manifest.json');
}

function isChartManifest(pathname: string): boolean {
  return pathname.endsWith('/chart-manifest.json') || pathname.endsWith('/mbtiles/manifest.json') ||
    pathname.endsWith('/mbtiles/packages/manifest.json');
}

async function chartArchiveResponse(request: Request): Promise<Response> {
  try {
    await noteCacheAccess(CHART_CACHE, request.url);
    const cache = await caches.open(chartArchiveCache);
    const key = new Request(request.url, { method: 'GET' });
    const read = request.method === 'HEAD' ? chartArchives.ensureStored.bind(chartArchives) : chartArchives.load.bind(chartArchives);
    const archive = await read(cache, key, (error) => {
      void publishChartArchiveError(key.url, error);
    });
    if (request.method === 'HEAD') return headResponse(archive);
    const range = request.headers.get('range');
    return range
      ? rangeResponse(archive, range)
      : new Response(archive.blob, { status: 200, headers: archive.headers });
  } catch (error) {
    const quota = error instanceof DOMException && error.name === 'QuotaExceededError';
    const message = quota ? 'Storage is full. Remove an offline region, then retry.'
      : 'Chart not saved or network unavailable. Reconnect and retry.';
    return new Response(null, { status: quota ? 507 : 503, headers: { 'x-zlayer-error': message,
      ...(resourceErrorCode(error) ? { 'x-zlayer-error-code': resourceErrorCode(error)! } : {}) } });
  }
}

async function publishChartArchiveError(url: string, error: Error): Promise<void> {
  const clients = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage({ type: 'chart-archive-error', url, message: error.message, code: resourceErrorCode(error) });
  }
}

function headResponse(archive: ChartArchive): Response {
  const headers = new Headers(archive.headers);
  headers.set('accept-ranges', 'bytes');
  return new Response(null, { status: 200, headers });
}

function rangeResponse(archive: ChartArchive, header: string): Response {
  const size = archive.blob.size;
  const match = header.match(/^bytes=(\d+)-(\d*)$/);
  if (!match) return new Response(null, { status: 416 });
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) ||
    start < 0 || start >= size || requestedEnd < start) {
    return new Response(null, {
      status: 416,
      headers: { 'content-range': `bytes */${size}` },
    });
  }

  const end = Math.min(requestedEnd, size - 1);
  const body = archive.blob.slice(start, end + 1);
  const headers = new Headers(archive.headers);
  headers.set('accept-ranges', 'bytes');
  headers.set('content-length', String(body.size));
  headers.set('content-range', `bytes ${start}-${end}/${size}`);
  return new Response(body, { status: 206, headers });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
