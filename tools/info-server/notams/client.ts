import { open, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { isRecord, type NotamEnvironment } from '@zlayer/contracts';
import type { NotamStore, NotamReservation } from './store';
import { NotamError } from './error';
import { retryAfterAt } from '../retry-after';

const HOSTS = { staging: 'https://api-staging.cgifederal-aim.com', production: 'https://api-nms.aim.faa.gov' };
export type NotamCredentials = { clientId: string; clientSecret: string };
export function createNotamSource(options: { environment: NotamEnvironment; credentials: NotamCredentials;
  store: NotamStore; signal: AbortSignal; fetch?: typeof fetch; now?: () => number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void> }) {
  const host = HOSTS[options.environment], now = options.now ?? Date.now, fetcher = options.fetch ?? fetch;
  let token: { value: string; expiresAt: number } | undefined;
  let renewing: Promise<string> | undefined;
  async function reserve(kind: 'auth' | 'content' | 'bulk' | 'delta', signal: AbortSignal) {
    const spacing = options.store.nextAnyAt - now();
    if (spacing > 1500) throw new NotamError('source-backoff', options.store.nextAnyAt);
    if (spacing > 0) await (options.wait ? options.wait(spacing, signal) : delay(spacing, undefined, { signal }));
    signal.throwIfAborted(); return options.store.reserve(kind, 120_000);
  }
  async function request(url: string, init: RequestInit, reservation: NotamReservation): Promise<Response> {
    init.signal?.throwIfAborted(); options.store.assertHeld();
    if (now() > reservation.dispatchBy) throw new NotamError('request-reservation-expired');
    let response: Response;
    try { response = await fetcher(url, { ...init, redirect: 'manual' }); }
    catch { await options.store.finishRequest(reservation); throw new NotamError('source-unreachable'); }
    let retryAt = 0;
    if ([429, 503].includes(response.status)) {
      const time = now();
      retryAt = Math.max(time + 30_000, retryAfterAt(response.headers.get('retry-after'), time) ?? 0);
    }
    try { await options.store.finishRequest(reservation, retryAt); }
    catch (cause) { await response.body?.cancel().catch(() => {}); throw cause; }
    if (retryAt) {
      await response.body?.cancel().catch(() => {});
      throw new NotamError('source-backoff', retryAt);
    }
    if (response.status === 401) { token = undefined; await response.body?.cancel(); throw new NotamError('authentication-failed'); }
    if (![200, 307].includes(response.status)) {
      await response.body?.cancel(); throw new NotamError(`source-http-${response.status}`);
    }
    return response;
  }
  async function json(response: Response): Promise<unknown> {
    const chunks: Uint8Array[] = []; let size = 0;
    if (response.body) for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > 65536) throw new NotamError('envelope-size-limit');
      chunks.push(chunk);
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new NotamError('invalid-envelope'); }
  }
  async function bearer(signal: AbortSignal): Promise<string> {
    if (token && token.expiresAt > now() + 30_000) return token.value;
    if (renewing) return renewing;
    renewing = (async () => {
      const reservation = await reserve('auth', signal);
      const started = now();
      const response = await request(`${host}/v1/auth/token`, { method: 'POST', signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization:
          `Basic ${Buffer.from(`${options.credentials.clientId}:${options.credentials.clientSecret}`).toString('base64')}` },
        body: 'grant_type=client_credentials' }, reservation);
      const value = await json(response);
      // FAA's Apigee token endpoint returns expires_in as a decimal string and
      // uses BearerToken. Both represent the ordinary Authorization: Bearer flow.
      const expires = isRecord(value) && typeof value.expires_in === 'string' && /^\d+$/.test(value.expires_in)
        ? Number(value.expires_in) : isRecord(value) ? value.expires_in : undefined;
      if (!isRecord(value) || typeof value.access_token !== 'string' || !/^[A-Za-z0-9._~+\/-]+=*$/.test(value.access_token) || value.access_token.length > 16384 ||
        typeof expires !== 'number' || !Number.isSafeInteger(expires) || expires <= 30 || expires > 86400 ||
        value.token_type !== undefined && !['bearer', 'bearertoken'].includes(String(value.token_type).toLowerCase())) throw new NotamError('invalid-token-response');
      token = { value: value.access_token, expiresAt: started + expires * 1000 }; return token.value;
    })();
    try { return await renewing; } finally { renewing = undefined; }
  }
  function contentUrl(reference: string): string {
    const path = reference.startsWith('/v1/content/') ? `/nmsapi${reference}` : reference;
    let url: URL;
    try { url = new URL(path, host); } catch { throw new NotamError('invalid-content-reference'); }
    if (reference.length > 8192 || url.origin !== host || url.username || url.password || url.search || url.hash ||
      !/^\/nmsapi\/v1\/content\/[A-Za-z0-9._~-]+$/.test(url.pathname)) throw new NotamError('invalid-content-reference');
    return url.href;
  }
  async function save(response: Response, path: string, maxBytes: number) {
    const handle = await open(path, 'wx', 0o600); let size = 0;
    try {
      if (!response.body) throw new NotamError('empty-source');
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > maxBytes) throw new NotamError('download-size-limit');
        await handle.writeFile(chunk);
      }
      if (!size) throw new NotamError('empty-source');
      const length = response.headers.get('content-length');
      if (!response.headers.get('content-encoding') && length !== null && Number(length) !== size) throw new NotamError('truncated-source');
    } catch (cause) { await rm(path, { force: true }); throw cause; }
    finally { await handle.close(); }
  }
  return {
    async download(kind: 'bulk' | 'delta', path: string, since?: number): Promise<{ requestedAt: number }> {
      const signal = AbortSignal.any([options.signal, AbortSignal.timeout(120_000)]);
      const url = new URL(`/nmsapi/v1/notams${kind === 'bulk' ? '/il' : ''}`, host);
      if (kind === 'bulk') url.searchParams.set('allowRedirect', 'false');
      else {
        if (since === undefined || !Number.isSafeInteger(since) || since > now()) throw new NotamError('delta-window-exceeded');
        since = Math.floor(since / 1000) * 1000;
        if (since < now() - 86_400_000) throw new NotamError('delta-window-exceeded');
        url.searchParams.set('lastUpdatedDate', new Date(since).toISOString().replace(/\.\d{3}Z$/, 'Z'));
      }
      const due = kind === 'bulk' ? options.store.nextBulkAt : options.store.nextDataAt;
      if (now() < due) throw new NotamError('request-budget', due);
      const authorization = `Bearer ${await bearer(signal)}`;
      const reservation = await reserve(kind, signal), requestedAt = now();
      let response = await request(url.href, { signal, headers: { Authorization: authorization, nmsResponseFormat: 'AIXM' } }, reservation);
      if (kind === 'bulk') {
        let reference: string;
        if (response.status === 307) {
          reference = response.headers.get('location') ?? ''; await response.body?.cancel();
        } else {
          const envelope = await json(response);
          if (!isRecord(envelope) || envelope.status !== 'Success' ||
            envelope.errors !== undefined && (!Array.isArray(envelope.errors) || envelope.errors.length > 0) ||
            !isRecord(envelope.data) || typeof envelope.data.url !== 'string') throw new NotamError('invalid-envelope');
          reference = envelope.data.url;
        }
        const target = contentUrl(reference);
        const content = await reserve('content', signal);
        response = await request(target, { signal, headers: { Authorization: authorization } }, content);
      }
      if (response.status !== 200) { await response.body?.cancel(); throw new NotamError('unexpected-redirect'); }
      await save(response, path, kind === 'bulk' ? 64 * 1024 * 1024 : 32 * 1024 * 1024);
      return { requestedAt };
    },
  };
}
