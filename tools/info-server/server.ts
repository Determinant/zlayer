import { createServer, type ServerResponse } from 'node:http';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { DEFAULT_WEATHER_CACHE_BYTES, WeatherCache } from './cache.ts';
import { HttpError, routeFor, type PreparedFamily } from './routes.ts';
import { createUpstream, type Payload } from './upstream.ts';
import { createProcessing } from './processing';
import { createForecastWarming, PUBLISHED_CATALOG } from './warming';
import { createProgsCoverageWarming, PUBLISHED_COVERAGE } from './progs-coverage';
import { createProgsWarming, PUBLISHED_PROGS } from './progs';
import { createRadarWarming, PUBLISHED_RADAR } from './radar';
import { createRadarMotionWarming, PUBLISHED_MOTION } from './radar-motion';
import { createNotamService, type NotamOptions } from './notams/service';
import { createNotamResponder } from './notams/routes';
import { createTfrService } from './notams/tfr-service';
import { createAdvisoryWarming } from './advisories';
import { assessInfoHealth } from './health';
import { InfoMetrics } from './metrics';
const compress = promisify(gzip);
const catalogMarkers: Record<PreparedFamily, string> = {
  forecast: PUBLISHED_CATALOG, progs: PUBLISHED_PROGS, coverage: PUBLISHED_COVERAGE, radar: PUBLISHED_RADAR, motion: PUBLISHED_MOTION,
};

function acceptsGzip(value: string | undefined): boolean {
  return !!value?.split(',').some(part => {
    const [coding, ...parameters] = part.trim().toLowerCase().split(';');
    const quality = parameters.map(parameter => parameter.trim()).find(parameter => parameter.startsWith('q='));
    const q = quality === undefined ? 1 : Number(quality.slice(2));
    return coding?.trim() === 'gzip' && q > 0 && q <= 1;
  });
}

export async function createInfoServer(options: { directory: string; maxBytes?: number; maxEntries?: number; origin?: string; sourceUrl?: string; notams?: NotamOptions;
  notamWait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  fetch?: typeof fetch; spacing?: number; userAgent?: string; now?: () => number; startUpdates?: boolean; log?: (message: string) => void }) {
  const shutdown = new AbortController();
  const tfrs = createTfrService({ ...options, directory: options.notams?.directory ?? options.directory, signal: shutdown.signal });
  await tfrs.restore();
  const metrics = new InfoMetrics();
  const notams = createNotamService(options.notams, { ...options, metrics, ...(options.notamWait ? { wait: options.notamWait } : {}), signal: shutdown.signal });
  const notamResponses = createNotamResponder(notams);
  const deliveries = { weather: 0, notams: 0 };
  function admit(kind: keyof typeof deliveries, response: ServerResponse): () => Promise<void> {
    if (deliveries[kind] >= (kind === 'weather' ? 32 : 16)) throw new HttpError(503, 'Info delivery busy', 1);
    deliveries[kind]++;
    const closed = new Promise<void>(resolve => response.once('close', resolve));
    // Encoding and disconnected clients still occupy capacity until work settles.
    return async () => { await closed; deliveries[kind]--; };
  }
  // Optional disk persistence may fail. Concurrent readers of the same validated
  // fallback body still share compression, without retaining a second body cache.
  const encodings = new WeakMap<Buffer, Promise<Buffer>>();
  function encode(body: Buffer): Promise<Buffer> {
    let encoded = encodings.get(body);
    if (!encoded) {
      encoded = compress(body).catch(cause => { encodings.delete(body); throw cause; });
      encodings.set(body, encoded);
    }
    return encoded;
  }
  let tfrResponse: { snapshot: ReturnType<typeof tfrs.read>; body: Buffer; encoded?: Promise<Buffer> } | undefined;
  void notams.restore();
  const upstream = createUpstream({ ...options, signal: shutdown.signal });
  const cache = new WeatherCache({ directory: options.directory, maxBytes: options.maxBytes ?? DEFAULT_WEATHER_CACHE_BYTES, now: options.now, signal: shutdown.signal,
    ...(options.maxEntries !== undefined ? { maxEntries: options.maxEntries } : {}),
    load: (resource, signal) => resource.kind === 'prepared' ? processing.load(resource) : upstream(resource, signal),
    ...(options.log ? { log: options.log } : {}) });
  const processing = createProcessing(cache, shutdown.signal, options.now);
  const warming = createForecastWarming(cache, processing, shutdown.signal, { ...options, metrics });
  const progs = createProgsWarming(cache, shutdown.signal, options);
  const coverage = createProgsCoverageWarming(cache, shutdown.signal, options);
  const radar = createRadarWarming(cache, shutdown.signal, options);
  const motion = createRadarMotionWarming(cache, shutdown.signal, options);
  const advisories = createAdvisoryWarming(cache, shutdown.signal, options);
  async function stopProducers() {
    shutdown.abort();
    const results = await Promise.allSettled([tfrs.close(), notams.close(), processing.close(),
      warming.close(), progs.close(), coverage.close(), radar.close(), motion.close(), advisories.close()]);
    // Producers have settled, so no new cache publications can join this drain.
    results.push(...await Promise.allSettled([cache.drain()]));
    metrics.close();
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Info server shutdown failed');
  }
  try {
    await cache.restore();
    await warming.restore(); await progs.restore(); await coverage.restore();
    await radar.restore(); await motion.restore(); await advisories.restore();
    await cache.prune();
  } catch (cause) {
    await stopProducers().catch(error => options.log?.(String(error)));
    throw cause;
  }
  const server = createServer(async (request, response) => {
    const path = request.url?.split('?')[0] ?? '';
    const finishRequest = metrics.request(path.endsWith('/healthz') ? 'health' : path.startsWith('/api/notams/') ? 'notams'
      : path.startsWith('/api/weather/') ? 'weather' : 'other');
    response.once('close', () => finishRequest(!response.writableFinished || response.statusCode >= 500));
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (options.sourceUrl) response.setHeader('Link', `<${options.sourceUrl}>; rel="source"`);
    if (options.origin) {
      response.setHeader('Access-Control-Allow-Origin', options.origin);
      response.setHeader('Access-Control-Expose-Headers', 'Content-Range, X-Weather-Checked-At, X-Weather-Cache, X-Weather-Artifact, X-Weather-Sha256, Retry-After');
      response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Range');
    }
    const demand = new AbortController();
    let releaseDelivery: (() => Promise<void>) | undefined;
    response.once('close', () => demand.abort());
    try {
      if (shutdown.signal.aborted) throw new HttpError(503, 'Info server is stopping', 5);
      if (request.method === 'OPTIONS' && options.origin) { response.writeHead(204).end(); return; }
      if (request.method !== 'GET' && request.method !== 'HEAD') { response.setHeader('Allow', 'GET, HEAD'); throw new HttpError(405, 'GET or HEAD required'); }
      if (request.url?.startsWith('/api/notams/') && request.url !== '/api/notams/healthz') {
        releaseDelivery = admit('notams', response);
      }
      if (request.url === '/api/notams/tfrs' && request.headers.range === undefined) {
        const snapshot = tfrs.read();
        if (snapshot && tfrResponse?.snapshot !== snapshot) {
          tfrResponse = { snapshot, body: Buffer.from(JSON.stringify(snapshot)) };
        }
        const saved = snapshot ? tfrResponse : undefined;
        const payload = saved?.body ?? Buffer.from(JSON.stringify({ error: 'tfrs-unavailable' }));
        const compressed = payload.length >= 1024 && acceptsGzip(request.headers['accept-encoding']);
        const body = compressed && saved ? await (saved.encoded ??= compress(payload).catch(cause => { delete saved.encoded; throw cause; })) : payload;
        if (response.destroyed) return;
        response.writeHead(snapshot ? 200 : 503, { 'Content-Type': 'application/json', 'Content-Length': body.length,
          Vary: 'Accept-Encoding', ...(compressed ? { 'Content-Encoding': 'gzip' } : {}), ...(!snapshot ? { 'Retry-After': '30' } : {}) });
        response.end(request.method === 'HEAD' ? undefined : body); return;
      }
      if (request.url === '/api/weather/healthz') {
        response.setHeader('Content-Type', 'application/json');
        const data = { forecasts: warming.status, progs: progs.status, progsCoverage: coverage.status,
          radar: radar.status, radarMotion: motion.status, advisories: advisories.status, notams: notams.status,
          notamReconciliation: notams.reconciliation, notamSourceIssues: notams.sourceIssues, tfrs: tfrs.status };
        response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ ok: true, ...data,
          readiness: assessInfoHealth(data, (options.now ?? Date.now)()), runtime: metrics.status,
          delivery: { ...deliveries }, cache: cache.stats, ...(options.sourceUrl ? { source: options.sourceUrl } : {}) })); return;
      }
      if (request.url?.startsWith('/api/notams/')) {
        const payload = notamResponses.read(request.url, request.headers.range);
        const compressed = payload.body.length >= 1024 && acceptsGzip(request.headers['accept-encoding']);
        const body = compressed ? await notamResponses.encoded(payload) : payload.body;
        if (response.destroyed) return;
        response.writeHead(payload.status, { 'Content-Type': 'application/json', 'Content-Length': body.length,
          Vary: 'Accept-Encoding', ...(compressed ? { 'Content-Encoding': 'gzip' } : {}),
          ...(payload.retryAfter ? { 'Retry-After': payload.retryAfter } : {}) });
        response.end(request.method === 'HEAD' ? undefined : body); return;
      }
      const route = routeFor(request.url ?? '', request.headers.range), { resource } = route;
      releaseDelivery = admit('weather', response);
      const gzipAccepted = acceptsGzip(request.headers['accept-encoding']);
      let saved = await cache.open(resource, gzipAccepted, request.method !== 'HEAD');
      let hit = !!saved, fallback: Payload | undefined;
      if (!saved && route.type === 'query') {
        const acquired = await cache.get(resource, undefined, demand.signal);
        hit = acquired.hit;
        saved = await cache.open(resource, gzipAccepted, request.method !== 'HEAD');
        if (!saved) fallback = acquired;
      }
      if (saved) {
        const { entry, handle, offset, length, gzip } = saved;
        try {
          if (route.type === 'catalog' && entry.headers['x-weather-catalog'] !== catalogMarkers[route.family]) {
            throw new HttpError(503, 'Prepared weather has not been published', 30);
          }
          if (response.destroyed) return;
          response.writeHead(entry.status, { ...entry.headers, 'Content-Length': length,
            ...(entry.headers['content-type']?.startsWith('application/json') ? { Vary: 'Accept-Encoding' } : {}),
            ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
            'X-Weather-Checked-At': String(entry.checkedAt), 'X-Weather-Sha256': entry.sha256, 'X-Weather-Cache': hit ? 'HIT' : 'MISS' });
          if (request.method === 'HEAD' || length === 0) response.end();
          else await pipeline(handle.createReadStream({ start: offset, end: offset + length - 1 }), response);
        } finally { await handle.close(); }
        return;
      }
      if (!fallback) throw new HttpError(route.type === 'artifact' ? 404 : 503,
        'Prepared weather is not retained; refresh the catalog', 30);
      const payload = fallback;
      if (response.destroyed) return;
      const json = payload.headers['content-type']?.startsWith('application/json');
      const compressed = json && payload.body.length >= 1024 && gzipAccepted;
      const body = compressed ? await encode(payload.body) : payload.body;
      if (response.destroyed) return;
      response.writeHead(payload.status, { ...payload.headers, ...(json ? { Vary: 'Accept-Encoding' } : {}),
        ...(compressed ? { 'Content-Encoding': 'gzip' } : {}), 'Content-Length': body.length,
        'X-Weather-Checked-At': String(payload.checkedAt), 'X-Weather-Sha256': payload.sha256,
        'X-Weather-Cache': hit ? 'HIT' : 'MISS' });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch (cause) {
      if (demand.signal.aborted) return;
      const error = cause instanceof HttpError ? cause : new HttpError(500, 'Info server error');
      if (!(cause instanceof HttpError)) options.log?.(String(cause));
      if (!response.destroyed && !response.headersSent) {
        if (error.retryAfter) response.setHeader('Retry-After', error.retryAfter);
        response.writeHead(error.status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error.message }));
      }
    } finally { await releaseDelivery?.(); }
  });
  server.requestTimeout = 10_000;
  server.timeout = 60_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 1000;
  server.maxConnections = 512;
  const refresh = () => {
    void tfrs.refresh();
    notams.refresh();
    warming.refresh();
    progs.refresh();
    coverage.refresh();
    radar.refresh();
    motion.refresh();
    advisories.refresh();
  };
  const timer = options.startUpdates === false ? undefined : setInterval(refresh, 30_000).unref();
  if (options.startUpdates !== false) refresh();
  let closing: Promise<void> | undefined;
  function close(): Promise<void> { return closing ??= (async () => {
    clearInterval(timer); shutdown.abort();
    const forced = setTimeout(() => server.closeAllConnections(), 5000).unref();
    try {
      const listener = server.listening ? new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) : Promise.resolve();
      const results = await Promise.allSettled([listener, stopProducers()]);
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, 'Info server shutdown failed');
    } finally { clearTimeout(forced); }
  })(); }
  return { server, metrics, cache, processing, forecasts: warming, progs, coverage, radar, motion, notams, tfrs, close };
}
