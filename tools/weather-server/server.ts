import { createServer } from 'node:http';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { WeatherCache } from './cache.ts';
import { HttpError, MiB, resourceFor } from './routes.ts';
import { createUpstream } from './upstream.ts';
import { createProcessing } from './processing';
import { createForecastWarming, PUBLISHED_CATALOG } from './warming';
import { createProgsWarming, PUBLISHED_PROGS } from './progs';
import { createRadarWarming, PUBLISHED_RADAR } from './radar';
import { createRadarMotionWarming, PUBLISHED_MOTION } from './radar-motion';
const compress = promisify(gzip);

function acceptsGzip(value: string | undefined): boolean {
  return !!value?.split(',').some(part => {
    const [coding, ...parameters] = part.trim().toLowerCase().split(';');
    const quality = parameters.map(parameter => parameter.trim()).find(parameter => parameter.startsWith('q='));
    const q = quality === undefined ? 1 : Number(quality.slice(2));
    return coding?.trim() === 'gzip' && q > 0 && q <= 1;
  });
}

export async function createWeatherServer(options: { directory: string; maxBytes?: number; origin?: string; sourceUrl?: string;
  fetch?: typeof fetch; spacing?: number; userAgent?: string; now?: () => number; startUpdates?: boolean; log?: (message: string) => void }) {
  const shutdown = new AbortController();
  const upstream = createUpstream({ ...options, signal: shutdown.signal });
  const cache = new WeatherCache({ directory: options.directory, maxBytes: options.maxBytes ?? 4096 * MiB, now: options.now, signal: shutdown.signal,
    load: (resource, signal) => resource.kind === 'prepared' ? processing.load(resource) : upstream(resource, signal),
    ...(options.log ? { log: options.log } : {}) });
  const processing = createProcessing(cache, shutdown.signal, options.now);
  await cache.restore();
  const warming = createForecastWarming(cache, processing, shutdown.signal, options);
  await warming.restore();
  const progs = createProgsWarming(cache, shutdown.signal, options);
  await progs.restore();
  const radar = createRadarWarming(cache, shutdown.signal, options);
  await radar.restore();
  const motion = createRadarMotionWarming(cache, shutdown.signal, options);
  await motion.restore();
  const server = createServer(async (request, response) => {
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
    response.once('close', () => demand.abort());
    try {
      if (shutdown.signal.aborted) throw new HttpError(503, 'Weather gateway is stopping', 5);
      if (request.method === 'OPTIONS' && options.origin) { response.writeHead(204).end(); return; }
      if (request.method !== 'GET' && request.method !== 'HEAD') { response.setHeader('Allow', 'GET, HEAD'); throw new HttpError(405, 'GET or HEAD required'); }
      if (request.url === '/api/weather/healthz') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ ok: true, cache: cache.stats, forecasts: warming.status, progs: progs.status, radar: radar.status, radarMotion: motion.status, ...(options.sourceUrl ? { source: options.sourceUrl } : {}) })); return;
      }
      const resource = resourceFor(request.url ?? '', request.headers.range);
      const forecast = new URL(resource.url).pathname.startsWith('/api/weather/grids/');
      const surface = new URL(resource.url).pathname.startsWith('/api/weather/progs/');
      const radarPath = new URL(resource.url).pathname.startsWith('/api/weather/radar/');
      const radarFile = radarPath && !resource.url.endsWith('/latest.json');
      const motionPath = new URL(resource.url).pathname.startsWith('/api/weather/radar/motion/');
      const surfaceFile = surface && /\/[a-f0-9]{64}\.json$/.test(resource.url);
      if (forecast || surface || radarPath) {
        const saved = await cache.open(resource, acceptsGzip(request.headers['accept-encoding']), request.method !== 'HEAD');
        if (!saved) throw new HttpError(radarFile || surfaceFile || !resource.url.endsWith('.json') ? 404 : 503,
          'Prepared weather is not retained; refresh the catalog', 30);
        const { entry, handle, offset, length, gzip } = saved;
        try {
          const catalog = !radarFile && !surfaceFile && resource.url.endsWith('.json');
          if (catalog && entry.headers['x-weather-catalog'] !== (motionPath ? PUBLISHED_MOTION : radarPath ? PUBLISHED_RADAR : surface ? PUBLISHED_PROGS : PUBLISHED_CATALOG)) {
            throw new HttpError(503, 'Prepared weather has not been published', 30);
          }
          if (response.destroyed) return;
          response.writeHead(entry.status, { ...entry.headers, 'Content-Length': length,
            ...(entry.headers['content-type']?.startsWith('application/json') ? { Vary: 'Accept-Encoding' } : {}),
            ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
            'X-Weather-Checked-At': String(entry.checkedAt), 'X-Weather-Sha256': entry.sha256, 'X-Weather-Cache': 'HIT' });
          if (request.method === 'HEAD') response.end();
          else await pipeline(handle.createReadStream({ start: offset, end: offset + length - 1 }), response);
        } finally { await handle.close(); }
        return;
      }
      const payload = await cache.get(resource, undefined, demand.signal);
      if (response.destroyed) return;
      const json = payload.headers['content-type']?.startsWith('application/json');
      const compressed = json && payload.body.length >= 1024 && acceptsGzip(request.headers['accept-encoding']);
      const body = compressed ? await compress(payload.body) : payload.body;
      if (response.destroyed) return;
      response.writeHead(payload.status, { ...payload.headers, ...(json ? { Vary: 'Accept-Encoding' } : {}),
        ...(compressed ? { 'Content-Encoding': 'gzip' } : {}), 'Content-Length': body.length,
        'X-Weather-Checked-At': String(payload.checkedAt), 'X-Weather-Sha256': payload.sha256,
        'X-Weather-Cache': payload.hit ? 'HIT' : 'MISS' });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch (cause) {
      if (demand.signal.aborted) return;
      const error = cause instanceof HttpError ? cause : new HttpError(500, 'Weather gateway error');
      if (!(cause instanceof HttpError)) options.log?.(String(cause));
      if (!response.destroyed && !response.headersSent) {
        if (error.retryAfter) response.setHeader('Retry-After', error.retryAfter);
        response.writeHead(error.status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error.message }));
      }
    }
  });
  server.requestTimeout = 10_000;
  server.timeout = 60_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 1000;
  const metadata = ['gairmet', 'sigmet', 'cwa'].map(product => `/api/weather/advisories/${product}.json`);
  const refresh = () => {
    warming.refresh();
    progs.refresh();
    radar.refresh();
    motion.refresh();
    for (const path of metadata) void cache.get(resourceFor(path), undefined, shutdown.signal).catch(() => {});
  };
  const timer = options.startUpdates === false ? undefined : setInterval(refresh, 30_000).unref();
  if (options.startUpdates !== false) refresh();
  let closing: Promise<void> | undefined;
  function close(): Promise<void> { return closing ??= (async () => {
    clearInterval(timer); shutdown.abort();
    await processing.close();
    await warming.close();
    await progs.close();
    await radar.close();
    await motion.close();
    await cache.drain();
    const forced = setTimeout(() => server.closeAllConnections(), 5000).unref();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    clearTimeout(forced);
  })(); }
  return { server, cache, processing, progs, radar, motion, close };
}
