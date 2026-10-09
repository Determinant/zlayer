import { createHash } from 'node:crypto';
import { isMetarFeatureCollection, isTafReport } from '@zlayer/contracts';
import { HttpError, InvalidForecastIndexError, InvalidForecastSourceError, type Resource } from './routes.ts';
import { UpstreamQueue } from './upstream-queue';
import { retryAfterAt } from './retry-after';
import { readGairmetCache } from './gairmet';
import { ADVISORY_MAX_AGE_MS } from './routes';
import { WeatherSourceError } from './source-error';

export type Payload = { body: Buffer; status: number; headers: Record<string, string>; checkedAt: number; sha256: string };
export const digest = (body: Uint8Array) => createHash('sha256').update(body).digest('hex');

export function createUpstream(options: { signal: AbortSignal; fetch?: typeof fetch; spacing?: number; userAgent?: string; now?: () => number }) {
  const queues = { awc: new UpstreamQueue(2, options.spacing ?? 1000), nomads: new UpstreamQueue(4, options.spacing ?? 600),
    hrrr: new UpstreamQueue(4, options.spacing ?? 100), radar: new UpstreamQueue(2, options.spacing ?? 250) };
  const fetcher = options.fetch ?? fetch;
  async function read(resource: Resource, signal: AbortSignal): Promise<Payload> {
    if (resource.upstream === 'prepared') throw new HttpError(500, 'Prepared data needs the processor');
    const queue = queues[resource.upstream];
    return queue.run(signal, async () => {
      let checkedAt = (options.now ?? Date.now)();
      const response = await fetcher(resource.url, { signal, redirect: 'error', headers: {
        'User-Agent': options.userAgent ?? 'ZLayer-info-server/0.1', 'Accept-Encoding': 'identity',
        ...(resource.revalidate ? { 'Cache-Control': 'no-cache' } : {}),
        ...(resource.range ? { Range: resource.range } : {}),
      } }).catch(() => { throw new HttpError(502, 'Upstream connection failed', 5); });
      try {
        if (response.status === 429 || response.status === 503) {
          const now = Date.now();
          throw queue.backoff(Math.max(now + 5000, retryAfterAt(response.headers.get('retry-after'), now) ?? now + 30_000));
        }
        const emptyReport = response.status === 204 && resource.kind === 'json' && resource.upstream === 'awc' &&
          ['/api/data/metar', '/api/data/taf'].includes(new URL(resource.url).pathname);
        if (response.status !== (resource.kind === 'range' ? 206 : 200) && !emptyReport) {
          throw new HttpError([403, 404, 416].includes(response.status) ? response.status : 502, `Upstream returned HTTP ${response.status}`, 5);
        }
        const encoding = response.headers.get('content-encoding');
        if (encoding && encoding !== 'identity') throw new HttpError(502, 'Unexpected upstream content encoding');
        const length = response.headers.get('content-length');
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > resource.maxBytes)) throw new HttpError(502, 'Upstream response exceeds its size limit');
        const chunks: Buffer[] = []; let size = 0;
        if (response.body) for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          size += chunk.byteLength;
          if (size > resource.maxBytes) throw new HttpError(502, 'Upstream response exceeds its size limit');
          chunks.push(Buffer.from(chunk));
        }
        if (length !== null && Number(length) !== size) throw new HttpError(502, 'Incomplete upstream response');
        let body = Buffer.concat(chunks, size);
        const headers: Record<string, string> = {};
        let status = response.status;
        if (resource.kind === 'gairmet-cache') {
          // The static cache is generated every minute. A successful CDN response
          // must not freshen an abandoned publication, even when HTTP says 200.
          const modified = Date.parse(response.headers.get('last-modified') ?? '');
          if (!Number.isFinite(modified) || modified > checkedAt + 30_000 || checkedAt - modified >= ADVISORY_MAX_AGE_MS) {
            throw new WeatherSourceError('G-AIRMET cache publication is stale or future dated',
              modified > checkedAt ? 'future-source' : 'stale-source');
          }
          checkedAt = Math.min(checkedAt, modified);
          body = Buffer.from(JSON.stringify(await readGairmetCache(body)));
          if (body.length > resource.maxBytes) throw new InvalidForecastSourceError('G-AIRMET package exceeds its size limit');
          headers['content-type'] = 'application/json; charset=utf-8';
        } else if (resource.kind === 'range') {
          const cr = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
          const requested = /^bytes=(\d+)-(\d*)$/.exec(resource.range!)!;
          if (!cr || !cr.slice(1).every(n => Number.isSafeInteger(Number(n))) || Number(cr[1]) !== Number(requested[1]) ||
            Number(cr[2]) - Number(cr[1]) + 1 !== size || Number(cr[3]) <= Number(cr[2]) ||
            Number(cr[2]) !== (requested[2] ? Number(requested[2]) : Number(cr[3]) - 1)) throw new InvalidForecastSourceError('Upstream returned the wrong byte range');
          let offset = 0;
          do {
            if (size - offset < 20 || body.toString('ascii', offset, offset + 4) !== 'GRIB' || body[offset + 7] !== 2) {
              throw new InvalidForecastSourceError('Invalid GRIB2 record boundary');
            }
            const length = Number(body.readBigUInt64BE(offset + 8));
            if (!Number.isSafeInteger(length) || length < 20 || length > size - offset ||
              body.toString('ascii', offset + length - 4, offset + length) !== '7777' || !resource.multipleGribs && length !== size) {
              throw new InvalidForecastSourceError('Incomplete GRIB2 record');
            }
            offset += length;
          } while (offset < size);
          headers['content-range'] = response.headers.get('content-range')!;
          headers['content-type'] = 'application/octet-stream';
          headers['accept-ranges'] = 'bytes';
        } else if (resource.kind === 'index') {
          const rows = body.toString('utf8').trim().split(/\r?\n/); let previous = -1;
          if (!body.length || rows.length > 2000 || rows.some((line, i) => {
            const fields = line.split(':'), offset = Number(fields[1]);
            const invalid = fields.length < 6 || fields[0] !== String(i + 1) || !/^\d+$/.test(fields[1] ?? '') || !Number.isSafeInteger(offset) ||
              offset <= previous || (i === 0 && offset !== 0) || !/^d=\d{10}$/.test(fields[2] ?? '');
            previous = offset; return invalid;
          })) throw new InvalidForecastIndexError('Invalid GRIB index');
          headers['content-type'] = 'text/plain; charset=utf-8';
        } else if (resource.kind === 'coverage-image') {
          if (response.headers.get('content-type')?.split(';')[0] !== 'image/png') throw new HttpError(502, 'Expected NDFD PNG');
          headers['content-type'] = 'image/png';
        } else if (resource.kind === 'radar-index' || resource.kind === 'radar-data') {
          if (!body.length) throw new HttpError(502, 'Empty radar source');
          headers['content-type'] = resource.kind === 'radar-index' ? 'application/xml' : 'application/octet-stream';
        } else {
          if (status === 204) { status = 200; body = Buffer.from(resource.url.includes('format=geojson') ? '{"type":"FeatureCollection","features":[]}' : '[]'); }
          let value: unknown;
          try { value = JSON.parse(body.toString('utf8')); } catch { throw new HttpError(502, 'Invalid upstream JSON'); }
          if (resource.kind === 'surface') {
            // Progs owns strict catalog/GeoJSON validation before publication.
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(502, 'Invalid surface JSON');
          } else if (resource.url.includes('format=geojson')) {
            const c = value as { type?: string; features?: unknown[]; exceededTransferLimit?: boolean } | null;
            if (!c || c.type !== 'FeatureCollection' || !Array.isArray(c.features) || c.features.length >= 400 || c.exceededTransferLimit) throw new HttpError(502, 'Incomplete upstream feature collection');
          } else if (!Array.isArray(value) || value.length >= 400) throw new HttpError(502, 'Incomplete upstream reports');
          const path = new URL(resource.url).pathname;
          if (path === '/api/data/metar' && !isMetarFeatureCollection(value) ||
            path === '/api/data/taf' && (!Array.isArray(value) || !value.every(isTafReport))) {
            throw new HttpError(502, 'Invalid upstream weather reports');
          }
          headers['content-type'] = 'application/json; charset=utf-8';
        }
        return { body, status, headers, checkedAt, sha256: digest(body) };
      } catch (cause) {
        if (cause instanceof HttpError) throw cause;
        throw new HttpError(502, 'Upstream response failed', 5);
      } finally { if (!response.bodyUsed) await response.body?.cancel().catch(() => {}); }
    });
  }
  return async (resource: Resource, demand?: AbortSignal): Promise<Payload> => {
    // One deadline includes queueing, transfer and complete-package validation.
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(45_000), ...(demand ? [demand] : [])]);
    return read(resource, signal);
  };
}
