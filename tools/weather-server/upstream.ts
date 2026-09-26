import { createHash } from 'node:crypto';
import { HttpError, InvalidForecastIndexError, InvalidForecastSourceError, type Resource } from './routes.ts';
import { UpstreamQueue } from './upstream-queue';

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
      const checkedAt = (options.now ?? Date.now)();
      const response = await fetcher(resource.url, { signal, redirect: 'error', headers: {
        'User-Agent': options.userAgent ?? 'ZLayer-weather-gateway/0.1', 'Accept-Encoding': 'identity',
        ...(resource.range ? { Range: resource.range } : {}),
      } });
      try {
        if (response.status === 429 || response.status === 503) {
          const retry = response.headers.get('retry-after'), numeric = Number(retry);
          const seconds = retry && Number.isFinite(numeric) ? numeric : retry ? (Date.parse(retry) - Date.now()) / 1000 : 30;
          throw queue.backoff(Date.now() + Math.min(300, Math.max(5, Number.isFinite(seconds) ? seconds : 30)) * 1000);
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
        if (resource.kind === 'range') {
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
          headers['content-type'] = 'application/json; charset=utf-8';
        }
        return { body, status, headers, checkedAt, sha256: digest(body) };
      } finally { if (!response.bodyUsed) await response.body?.cancel().catch(() => {}); }
    });
  }
  return async (resource: Resource, demand?: AbortSignal): Promise<Payload> => {
    // One deadline includes queueing and every frame of a package.
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(45_000), ...(demand ? [demand] : [])]);
    if (resource.kind !== 'package') return read(resource, signal);
    const checkedAt = (options.now ?? Date.now)(), date = new Date(checkedAt).toISOString(), collections: unknown[] = [], bases = new Set<number>();
    for (const hour of [0, 3, 6, 9, 12]) {
      const url = new URL(resource.url); url.search = new URLSearchParams({ format: 'geojson', fore: String(hour), date }).toString();
      const part = await read({ ...resource, kind: 'json', url: url.href }, signal);
      const collection = JSON.parse(part.body.toString('utf8'));
      for (const feature of collection.features) {
        const p = feature?.properties, valid = Date.parse(p?.validTime);
        if (p?.forecast !== hour || !Number.isFinite(valid)) throw new HttpError(502, 'Invalid G-AIRMET forecast identity');
        bases.add(valid - hour * 3600_000);
      }
      collections.push(collection);
    }
    if (bases.size > 1) throw new HttpError(502, 'G-AIRMET package changed during refresh');
    const body = Buffer.from(JSON.stringify(collections));
    if (body.length > resource.maxBytes) throw new HttpError(502, 'G-AIRMET package exceeds its size limit');
    return { body, status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, checkedAt, sha256: digest(body) };
  };
}
