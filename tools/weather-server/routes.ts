export const MiB = 1024 * 1024;
export type Resource = {
  key: string; upstream: 'awc' | 'nomads' | 'hrrr' | 'prepared'; url: string; kind: 'json' | 'package' | 'index' | 'range' | 'prepared';
  ttl: number; maxBytes: number; range?: string; indexHash?: string; multipleGribs?: true;
};
export class HttpError extends Error {
  status: number;
  retryAfter: number;
  constructor(status: number, message: string, retryAfter = 0) {
    super(message); this.status = status; this.retryAfter = retryAfter;
  }
}
/** A successful source response cannot satisfy the pinned forecast identity. */
export class InvalidForecastSourceError extends HttpError {
  constructor(message: string) { super(502, message, 5); }
}
/** An incomplete or incompatible index lets discovery try an older cycle. */
export class InvalidForecastIndexError extends InvalidForecastSourceError {}
const awc = 'https://aviationweather.gov/api/data/';
const nomads = 'https://nomads.ncep.noaa.gov/pub/data/nccf/com/';
/** Fixed origins and narrow paths: only application reports, advisories and prepared grids are public. */
export function resourceFor(path: string, range?: string): Resource {
  if (path.length > 4096 || !path.startsWith('/') || path.startsWith('//') || /[#\\\x00-\x20]/.test(path)) {
    throw new HttpError(400, 'Invalid request path');
  }
  const url = new URL(path, 'http://weather.invalid');
  if (path.split('?')[0] !== url.pathname || /%/.test(url.pathname)) throw new HttpError(400, 'Invalid request path');
  const query = url.searchParams;
  if ([...query.keys()].some(key => query.getAll(key).length !== 1)) throw new HttpError(400, 'Duplicate query parameter');
  if (/^\/api\/weather\/(advisories\/(gairmet|sigmet|cwa)|grids\/(clouds|icing|winds))\.json$/.test(url.pathname) ||
    /^\/api\/weather\/grids\/(?:(?:clouds|icing)\/\d{13}-\d{1,2}-\d{1,5}|winds\/\d{13}-\d{1,2}-p\d{3,4})-[a-f0-9]{64}\.zwp\.gz$/.test(url.pathname) ||
    /^\/api\/weather\/grids\/winds\/\d{13}-terrain-[a-f0-9]{64}\.zwt\.gz$/.test(url.pathname)) {
    if (query.size || range) throw new HttpError(400, 'Prepared weather takes no query or range');
    return { key: url.pathname, upstream: 'prepared', url: url.href, kind: 'prepared',
      ttl: url.pathname.includes('/advisories/') ? 60_000 : 86_400_000, maxBytes: url.pathname.endsWith('.json') ? 4 * MiB : 16 * MiB };
  }
  const product = url.pathname === '/api/weather/metars.geojson' ? 'metar' : url.pathname === '/api/weather/tafs.json' ? 'taf' : undefined;
  if (product) {
    if (range) throw new HttpError(400, 'Weather reports do not accept ranges');
    const allowed = product === 'metar' ? ['ids', 'bbox', 'format', 'hours'] : ['ids', 'bbox', 'format'];
    if ([...query.keys()].some(key => !allowed.includes(key))) throw new HttpError(400, 'Unsupported query parameter');
    const format = product === 'taf' ? 'json' : 'geojson';
    if (query.has('format') && query.get('format') !== format) throw new HttpError(400, 'Unsupported output format');
    query.set('format', format);
    if (query.has('ids') === query.has('bbox')) throw new HttpError(400, 'Supply either ids or bbox');
    if (query.has('ids')) {
      const ids = [...new Set(query.get('ids')!.toUpperCase().split(','))].sort();
      if (ids.length > 100 || ids.some(id => !/^[A-Z0-9]{3,5}$/.test(id))) throw new HttpError(400, 'Invalid station IDs');
      query.set('ids', ids.join(','));
    } else {
      const raw = query.get('bbox')!.split(',');
      const box = raw.map(Number);
      if (box.length !== 4 || raw.some(n => !n.trim()) || box.some(n => !Number.isFinite(n)) ||
        Math.abs(box[0]!) > 90 || Math.abs(box[2]!) > 90 || Math.abs(box[1]!) > 180 || Math.abs(box[3]!) > 180 ||
        box[0]! >= box[2]! || box[1]! >= box[3]!) throw new HttpError(400, 'Invalid bounding box');
      query.set('bbox', box.join(','));
    }
    if (query.has('hours')) {
      const hours = Number(query.get('hours'));
      if (!Number.isInteger(hours) || hours < 1 || hours > 24) throw new HttpError(400, 'Invalid observation lookback');
      query.set('hours', String(hours));
    }
    query.sort();
    const upstream = `${awc}${product}?${query}`;
    return { key: upstream, upstream: 'awc', url: upstream, kind: 'json', ttl: product === 'metar' ? 30_000 : 60_000, maxBytes: 4 * MiB };
  }
  throw new HttpError(404, 'Unknown weather resource');
}

/** Internal upstream resources have no public raw-data route. */
export function advisoryResource(product: 'gairmet' | 'sigmet' | 'cwa'): Resource {
  const url = `${awc}${product === 'sigmet' ? 'airsigmet' : product}${product === 'gairmet' ? '' : '?format=geojson'}`;
  return { key: url, upstream: 'awc', url, kind: product === 'gairmet' ? 'package' : 'json', ttl: 60_000, maxBytes: 4 * MiB };
}

export function modelResource(path: string, range?: string, indexHash?: string): Resource {
  const hrrr = /^(hrrr\/prod\/hrrr\.(\d{8})\/conus\/hrrr\.t(\d{2})z\.wrf(?:sfc|prs)f(\d{2})\.grib2)(\.idx)?$/.exec(path);
  const file = hrrr ?? /^(dafs\/prod\/dafs\.(\d{8})\/dafs\.t(\d{2})z\.ifi\.3km\.conus\.f(\d{3})\.grib2)(\.idx)?$/.exec(path);
  if (!file) throw new HttpError(404, 'Unknown weather resource');
  const day = file[2]!, date = new Date(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T00:00:00Z`);
  if (!Number.isFinite(+date) || date.toISOString().slice(0, 10).replaceAll('-', '') !== day || Number(file[3]) > 23 ||
    Number(file[4]) < (hrrr ? 0 : 1) || Number(file[4]) > 18) throw new HttpError(400, 'Invalid model cycle or forecast hour');
  const index = !!file[5];
  if (indexHash !== undefined && (index || !/^[a-f0-9]{64}$/.test(indexHash))) throw new HttpError(400, 'Invalid index identity');
  // Use the ordinary Google object URL on the server; index and ranges share it.
  const upstream = hrrr ? 'https://storage.googleapis.com/high-resolution-rapid-refresh/' + file[1]!.slice('hrrr/prod/'.length) + (index ? '.idx' : '')
    : nomads + file[1] + (index ? '.idx' : '');
  const family = hrrr ? 'hrrr' : 'nomads';
  if (index) {
    if (range) throw new HttpError(400, 'Index ranges are unsupported');
    return { key: upstream, upstream: family, url: upstream, kind: 'index', ttl: 60_000, maxBytes: 512 * 1024 };
  }
  const match = /^bytes=(\d+)-(\d*)$/.exec(range ?? '');
  const start = Number(match?.[1]), end = match?.[2] ? Number(match[2]) : undefined;
  if (!match || !Number.isSafeInteger(start) || start < 0 || end !== undefined &&
    (!Number.isSafeInteger(end) || end < start || end - start + 1 > 8 * MiB)) throw new HttpError(416, 'A single GRIB range of at most 8 MiB is required');
  const normalizedRange = `bytes=${start}-${end ?? ''}`;
  return { key: `${upstream}|${normalizedRange}|${indexHash ?? ''}`, upstream: family, url: upstream,
    kind: 'range', ttl: indexHash ? 24 * 3600_000 : 60_000, maxBytes: 8 * MiB, range: normalizedRange, ...(indexHash ? { indexHash } : {}) };
}
