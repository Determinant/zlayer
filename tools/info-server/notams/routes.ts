import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { isNotamAirportQuery, isNotamNavaidQuery, isNotamRegionQuery, notamQueryKey, NOTAM_AIRPORT_MAX_BYTES, type NotamQuery, type NotamSnapshot } from '@zlayer/contracts';
import { NotamError } from './error';
import type { createNotamService } from './service';

const compress = promisify(gzip);
const MAX_CACHE_BYTES = 32 * 1024 * 1024, MAX_CACHE_ENTRIES = 128;
type Payload = { status: number; body: Buffer; retryAfter?: number };
type Entry = { payload: Payload; bytes: number; encoded?: Promise<Buffer> };

/** Bound construction before joining the full response. An issue may contain
 * several large variants, so serialize each validated record independently. */
function snapshotBytes(snapshot: NotamSnapshot): Buffer {
  const chunks: Buffer[] = []; let size = 0;
  const append = (text: string) => {
    size += Buffer.byteLength(text);
    if (size > NOTAM_AIRPORT_MAX_BYTES) throw new NotamError('airport-size-limit');
    chunks.push(Buffer.from(text));
  };
  const array = <T>(items: readonly T[], write: (item: T) => void) => {
    append('['); items.forEach((item, i) => { if (i) append(','); write(item); }); append(']');
  };
  const { records, issues, ...metadata } = snapshot;
  append(JSON.stringify(metadata).slice(0, -1)); append(',"records":');
  array(records, record => append(JSON.stringify(record)));
  if (issues) {
    append(',"issues":');
    array(issues, ({ variants, ...issue }) => {
      append(JSON.stringify(issue).slice(0, -1)); append(',"variants":');
      array(variants, record => append(JSON.stringify(record))); append('}');
    });
  }
  append('}'); return Buffer.concat(chunks, size);
}

/** Read-only capability: HTTP has no collection or source-request entry point.
 * Cache both encodings by query and complete feed status, with bounded retention.
 * Freshness/backoff transitions invalidate replies even on unchanged datasets. */
export function createNotamResponder(service: Pick<ReturnType<typeof createNotamService>, 'status' | 'readAirport' | 'readNavaid' | 'readRegion'>,
  encode: (body: Buffer) => Promise<Buffer> = compress) {
  const cache = new Map<string, Entry>(), entries = new WeakMap<Payload, Entry>();
  let boundary = '', bytes = 0;
  const result = (status: number, value: unknown, retryAfter?: number): Payload => ({ status, body: Buffer.from(JSON.stringify(value)),
    ...(retryAfter === undefined ? {} : { retryAfter }) });
  function trim() {
    while (bytes > MAX_CACHE_BYTES || cache.size > MAX_CACHE_ENTRIES) {
      const key = cache.keys().next().value!; bytes -= cache.get(key)!.bytes; cache.delete(key);
    }
  }
  function remember(key: string, payload: Payload): Payload {
    const entry = { payload, bytes: payload.body.length };
    cache.set(key, entry); entries.set(payload, entry); bytes += entry.bytes; trim();
    return payload;
  }
  function read(raw: string, range: string | undefined): Payload {
    if (raw.length > 256 || range !== undefined) return result(400, { error: 'invalid-request' });
    const url = new URL(raw, 'http://localhost');
    if (url.hash || url.pathname !== raw.split('?', 1)[0]) return result(400, { error: 'invalid-request' });
    if (url.pathname === '/api/notams/healthz' && !url.search) return result(200, service.status);
    const navaid = url.pathname === '/api/notams/navaids';
    const region = url.pathname === '/api/notams/regions';
    if (!navaid && !region && url.pathname !== '/api/notams/airports') return result(404, { error: 'not-found' });
    const queryError = region ? 'invalid-region-query' : navaid ? 'invalid-navaid-query' : 'invalid-airport-query';
    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams) {
      if (!(region ? key === 'artccId' || key === 'firId' : navaid ? key === 'navaidId' : key === 'faaId' || key === 'icaoId') || key in query)
        return result(400, { error: queryError });
      query[key] = value.trim().toUpperCase();
    }
    if (!(region ? isNotamRegionQuery(query) : navaid ? isNotamNavaidQuery(query) : isNotamAirportQuery(query)))
      return result(400, { error: queryError });
    const key = notamQueryKey(query as NotamQuery);
    try {
      const status = JSON.stringify(service.status);
      if (status !== boundary) { cache.clear(); bytes = 0; boundary = status; }
      const saved = cache.get(key);
      if (saved) { cache.delete(key); cache.set(key, saved); return saved.payload; }
      const snapshot = isNotamRegionQuery(query) ? service.readRegion(query)
        : isNotamNavaidQuery(query) ? service.readNavaid(query) : service.readAirport(query);
      if (!snapshot) return result(503, { error: service.status.enabled ? 'notams-unavailable' : 'notams-disabled', feed: service.status }, 180);
      return remember(key, { status: 200, body: snapshotBytes(snapshot) });
    } catch (cause) {
      const payload = result(503, { error: cause instanceof NotamError ? cause.code : 'notams-unavailable' }, 180);
      return cause instanceof NotamError && cause.code === 'airport-size-limit' ? remember(key, payload) : payload;
    }
  }
  return { read,
    async encoded(payload: Payload): Promise<Buffer> {
      const entry = entries.get(payload);
      if (!entry) return encode(payload.body);
      return entry.encoded ??= encode(payload.body).then(body => {
        entry.bytes += body.length;
        if ([...cache.values()].includes(entry)) { bytes += body.length; trim(); }
        return body;
      }).catch(cause => { delete entry.encoded; throw cause; });
    },
    get stats() { return { entries: cache.size, bytes }; },
  };
}
