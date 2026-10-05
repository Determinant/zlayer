import { isNotamAirportQuery, NOTAM_AIRPORT_MAX_BYTES, type NotamAirportQuery } from '@zlayer/contracts';
import { NotamError } from './error';
import type { createNotamService } from './service';

/** Pure local reads. There is deliberately no refresh/acquisition entry point here. */
export function notamResponse(raw: string, range: string | undefined, service: ReturnType<typeof createNotamService>) {
  const result = (status: number, value: unknown, retryAfter?: number) => ({ status, body: Buffer.from(JSON.stringify(value)), retryAfter });
  if (raw.length > 256 || range !== undefined) return result(400, { error: 'invalid-request' });
  const url = new URL(raw, 'http://localhost');
  if (url.hash || url.pathname !== raw.split('?', 1)[0]) return result(400, { error: 'invalid-request' });
  if (url.pathname === '/api/notams/healthz' && !url.search) return result(200, service.status);
  if (url.pathname !== '/api/notams/airports') return result(404, { error: 'not-found' });
  const query: NotamAirportQuery = {};
  for (const [key, value] of url.searchParams) {
    if ((key !== 'faaId' && key !== 'icaoId') || key in query) return result(400, { error: 'invalid-airport-query' });
    query[key] = value.trim().toUpperCase();
  }
  if (!isNotamAirportQuery(query)) return result(400, { error: 'invalid-airport-query' });
  try {
    const snapshot = service.readAirport(query);
    if (!snapshot) return result(503, { error: service.status.enabled ? 'notams-unavailable' : 'notams-disabled', feed: service.status }, 180);
    const response = result(200, snapshot);
    return response.body.length <= NOTAM_AIRPORT_MAX_BYTES ? response : result(503, { error: 'airport-size-limit' }, 180);
  } catch (cause) {
    return result(503, { error: cause instanceof NotamError ? cause.code : 'notams-unavailable' }, 180);
  }
}
