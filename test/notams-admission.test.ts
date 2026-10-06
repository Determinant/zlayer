import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNotamSource } from '../tools/info-server/notams/client';
import { NotamStore, NOTAM_DAY_MS } from '../tools/info-server/notams/store';
import { createNotamService } from '../tools/info-server/notams/service';
import { createNotamXmlParser } from '../tools/info-server/notams/normalize';
import { workerJob } from '../tools/info-server/worker-job';
import { aixm, notice, NOTAM_NOW } from './fixtures/notams';

const credentials = { clientId: 'fixture', clientSecret: 'fixture' };
const token = () => Response.json({ access_token: 'fixture-token', expires_in: '1799', token_type: 'BearerToken' });
async function temporary() { return mkdtemp(join(tmpdir(), 'notam-admission-')); }

test('an interrupted dispatch reservation retains its full crash margin through restart', async () => {
  const directory = await temporary(); let now = NOTAM_NOW;
  let store = new NotamStore(directory, 'production', () => now);
  try {
    await store.restore();
    const reservation = await store.reserve('bulk', 120_000);
    assert.equal(reservation.dispatchBy, now + 120_000);
    await store.close(); now += 120_000;
    store = new NotamStore(directory, 'production', () => now); await store.restore();
    assert.equal(store.nextAnyAt, now + 1000);
    assert.equal(store.nextDataAt, now + 180_000);
    assert.equal(store.nextBulkAt, now + NOTAM_DAY_MS);
    await assert.rejects(store.reserve('content'), /request-budget/);
    now += 1000; await store.reserve('content');
    now += 179_000; await store.reserve('delta');
    await assert.rejects(store.finishRequest(reservation), /invalid-reservation/);
    assert.equal(store.nextDataAt, now + 180_000, 'an old receipt cannot shorten a later reservation');
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('completed attempts release only their provisional margin and preserve concurrent backoff', async () => {
  const directory = await temporary(); let now = NOTAM_NOW;
  const store = new NotamStore(directory, 'production', () => now);
  try {
    await store.restore(); const reservation = await store.reserve('bulk', 120_000);
    now += 75_000;
    await Promise.all([store.backoff(now + 900_000), store.finishRequest(reservation)]);
    const saved = JSON.parse(await readFile(join(directory, 'budget.json'), 'utf8'));
    assert.equal(saved.anyAt, now + 1000); assert.equal(saved.dataAt, now + 180_000);
    assert.equal(saved.bulkAt, now + NOTAM_DAY_MS); assert.equal(saved.backoffAt, now + 900_000);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a slow durable reservation cannot dispatch outside its charged window', async () => {
  const directory = await temporary(); let now = NOTAM_NOW, calls = 0;
  const store = new NotamStore(directory, 'production', () => now), reserve = store.reserve.bind(store);
  store.reserve = async (...args) => { const receipt = await reserve(...args); now += 120_001; return receipt; };
  try {
    await store.restore();
    const source = createNotamSource({ environment: 'production', credentials, store, now: () => now,
      signal: new AbortController().signal, fetch: async () => { calls++; return token(); } });
    await assert.rejects(source.download('bulk', join(directory, 'source.tmp')), /request-reservation-expired/);
    assert.equal(calls, 0); assert.equal(store.nextAuthAt, NOTAM_NOW + 300_000);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('normal global collection spaces every actual request, reuses its token and consumes one data slot', async () => {
  const directory = await temporary(); let now = NOTAM_NOW;
  const calls: { path: string; started: number; finished: number }[] = [];
  const store = new NotamStore(directory, 'production', () => now);
  try {
    await store.restore();
    const source = createNotamSource({ environment: 'production', credentials, store, now: () => now,
      wait: async ms => { now += ms; }, signal: new AbortController().signal, fetch: async input => {
        const path = new URL(String(input)).pathname, started = now; now += 25;
        calls.push({ path, started, finished: now });
        if (path === '/v1/auth/token') return token();
        if (path.endsWith('/il')) return Response.json({ status: 'Success', data: { url: '/v1/content/fixture' } });
        return new Response('fixture');
      } });
    await source.download('bulk', join(directory, 'bulk.tmp'));
    now = store.nextDataAt; await source.download('delta', join(directory, 'delta.tmp'), now - 600_000);
    assert.deepEqual(calls.map(c => c.path), ['/v1/auth/token', '/nmsapi/v1/notams/il', '/nmsapi/v1/content/fixture', '/nmsapi/v1/notams']);
    assert.ok(calls.every((call, i) => !i || call.started - calls[i - 1]!.finished >= 1000));
    assert.equal(calls[3]!.started - calls[1]!.finished, 180_000);
    assert.equal(store.nextBulkAt, calls[1]!.finished + NOTAM_DAY_MS);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('an early timer wake cannot abandon an admitted bulk download at the content-spacing boundary', async () => {
  const directory = await temporary(); let now = NOTAM_NOW, waits = 0;
  const calls: { path: string; started: number; finished: number }[] = [];
  const store = new NotamStore(directory, 'production', () => now);
  try {
    await store.restore();
    const source = createNotamSource({ environment: 'production', credentials, store, now: () => now,
      signal: new AbortController().signal,
      wait: async ms => { waits++; now += waits === 2 ? ms - 1 : ms; },
      fetch: async input => {
        const path = new URL(String(input)).pathname, started = now; now += 25;
        calls.push({ path, started, finished: now });
        if (path === '/v1/auth/token') return token();
        if (path.endsWith('/il')) return Response.json({ status: 'Success', data: { url: '/v1/content/fixture' } });
        return new Response('complete bulk');
      } });
    const path = join(directory, 'bulk.tmp'); await source.download('bulk', path);
    assert.equal(await readFile(path, 'utf8'), 'complete bulk');
    assert.deepEqual(calls.map(call => call.path), ['/v1/auth/token', '/nmsapi/v1/notams/il', '/nmsapi/v1/content/fixture']);
    assert.ok(calls.every((call, i) => !i || call.started - calls[i - 1]!.finished >= 1000));
    assert.equal(store.nextBulkAt, calls[1]!.finished + NOTAM_DAY_MS);
    assert.equal(waits, 3, 'the remaining millisecond is waited without another data request');
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a rejected bearer cannot cause an immediate retry and renews only on the next data slot', async () => {
  const directory = await temporary(); let now = NOTAM_NOW, tokens = 0, pulls = 0;
  const store = new NotamStore(directory, 'production', () => now);
  try {
    await store.restore();
    const source = createNotamSource({ environment: 'production', credentials, store, now: () => now,
      wait: async ms => { now += ms; }, signal: new AbortController().signal, fetch: async input => {
        if (new URL(String(input)).pathname === '/v1/auth/token') { tokens++; return token(); }
        pulls++; return pulls === 1 ? new Response(null, { status: 401 }) : new Response('fixture');
      } });
    await assert.rejects(source.download('delta', join(directory, 'delta.tmp'), now - 600_000), /authentication-failed/);
    await assert.rejects(source.download('delta', join(directory, 'delta.tmp'), now - 600_000), /request-budget/);
    assert.equal(tokens, 1); assert.equal(pulls, 1);
    now = store.nextDataAt;
    await source.download('delta', join(directory, 'delta.tmp'), now - 600_000);
    assert.equal(tokens, 2); assert.equal(pulls, 2);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('malformed token responses cannot reach data endpoints or escape as credential-bearing errors', async () => {
  const directory = await temporary(); let now = NOTAM_NOW, calls = 0;
  const store = new NotamStore(directory, 'production', () => now);
  try {
    await store.restore();
    for (const value of [{ access_token: 'fixture\r\nsecret', expires_in: '1799' },
      { access_token: 'fixture', expires_in: 'bad-secret' }, { access_token: 'fixture', expires_in: 1800, token_type: 'unknown' }]) {
      const source = createNotamSource({ environment: 'production', credentials, store, now: () => now,
        signal: new AbortController().signal, fetch: async input => {
          calls++; assert.equal(new URL(String(input)).pathname, '/v1/auth/token'); return Response.json(value);
        } });
      await assert.rejects(source.download('delta', join(directory, 'delta.tmp'), now - 600_000), { message: 'invalid-token-response' });
      now += 180_000;
    }
    assert.equal(calls, 3); assert.equal(store.nextDataAt, 0);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('simultaneous admissions cannot double-spend and backoff cannot overwrite a reservation', async () => {
  const directory = await temporary(); let now = NOTAM_NOW;
  const store = new NotamStore(directory, 'production', () => now);
  try {
    await store.restore();
    const admissions = await Promise.allSettled(Array.from({ length: 50 }, () => store.reserve('delta')));
    assert.equal(admissions.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(store.nextDataAt, now + 180_000);
    now += 180_000;
    await Promise.all([store.reserve('delta'), store.backoff(now + 3600_000)]);
    let saved = JSON.parse(await readFile(join(directory, 'budget.json'), 'utf8'));
    assert.equal(saved.dataAt, now + 180_000); assert.equal(saved.backoffAt, now + 3600_000);
    now += 3600_000;
    const [backoff, reservation] = await Promise.allSettled([store.backoff(now + 3600_000), store.reserve('bulk')]);
    assert.equal(backoff.status, 'fulfilled'); assert.equal(reservation.status, 'rejected');
    saved = JSON.parse(await readFile(join(directory, 'budget.json'), 'utf8'));
    assert.equal(saved.bulkAt, 0, 'rejected admission cannot spend or reset another allowance');
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('failed token requests stay at least three minutes apart through rapid process restarts', async () => {
  const directory = await temporary(); let now = NOTAM_NOW;
  const calls: number[] = [];
  try {
    for (let restart = 0; restart < 72; restart++, now += 5000) {
      const store = new NotamStore(directory, 'production', () => now);
      try {
        await store.restore();
        const source = createNotamSource({ environment: 'production', credentials, store, now: () => now, wait: async ms => { now += ms; },
          signal: new AbortController().signal, fetch: async input => {
            assert.equal(new URL(String(input)).pathname, '/v1/auth/token'); calls.push(now); return new Response(null, { status: 401 });
          } });
        await assert.rejects(source.download('bulk', join(directory, 'source.tmp')));
      } finally { await store.close(); }
    }
    assert.equal(calls.length, 2);
    assert.ok(calls.every((time, i) => !i || time - calls[i - 1]! >= 180_000));
    const saved = JSON.parse(await readFile(join(directory, 'budget.json'), 'utf8'));
    assert.equal(saved.bulkAt, 0); assert.equal(saved.dataAt, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('legacy admission journals conservatively preserve token spacing without changing data or bulk allowance', async () => {
  const directory = await temporary(); const now = NOTAM_NOW;
  let store = new NotamStore(directory, 'production', () => now);
  try {
    await store.restore(); await store.reserve('bulk'); await store.close();
    const path = join(directory, 'budget.json'), saved = JSON.parse(await readFile(path, 'utf8'));
    delete saved.authAt; delete saved.sha256; saved.schemaVersion = 1; await writeFile(path, JSON.stringify(saved));
    store = new NotamStore(directory, 'production', () => now + 1001); await store.restore();
    await assert.rejects(store.reserve('auth'), /request-budget/);
    assert.equal(store.nextDataAt, now + 180_000); assert.equal(store.nextBulkAt, now + NOTAM_DAY_MS);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), saved);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const status of [429, 503]) for (const retry of ['900', new Date(NOTAM_NOW + 3600_000).toUTCString()]) {
  test(`HTTP ${status} Retry-After ${retry} survives restart and response cancellation failure`, async () => {
    const directory = await temporary(); let now = NOTAM_NOW, calls = 0;
    let store = new NotamStore(directory, 'production', () => now);
    const fetcher: typeof fetch = async input => {
      calls++; now += 1001;
      if (new URL(String(input)).pathname === '/v1/auth/token') return token();
      return new Response(new ReadableStream({ cancel() { throw new Error('fixture cancellation failure'); } }), { status, headers: { 'Retry-After': retry } });
    };
    const source = () => createNotamSource({ environment: 'production', credentials, store, now: () => now, wait: async ms => { now += ms; }, signal: new AbortController().signal, fetch: fetcher });
    try {
      await store.restore(); await assert.rejects(source().download('delta', join(directory, 'source.tmp'), now - 600_000), /source-backoff/);
      const until = store.nextDataAt; assert.ok(until >= NOTAM_NOW + 900_000); assert.equal(calls, 2);
      await store.close(); now += 180_000; store = new NotamStore(directory, 'production', () => now); await store.restore();
      await assert.rejects(source().download('delta', join(directory, 'source.tmp'), now - 600_000), /request-budget/);
      assert.equal(calls, 2); assert.equal(store.nextDataAt, until);
    } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
  });
}

test('checksummed admission rejects plausible numeric corruption and oversized journals', async () => {
  const directory = await temporary(); let store = new NotamStore(directory, 'production', () => NOTAM_NOW);
  try {
    await store.restore(); await store.reserve('bulk'); await store.close();
    const path = join(directory, 'budget.json'), original = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(original.schemaVersion, 2);
    for (const damaged of [{ ...original, bulkAt: 0 }, { ...original, dataAt: 0 },
      { ...original, schemaVersion: 1 }, { ...original, padding: 'x'.repeat(20_000) }]) {
      await writeFile(path, JSON.stringify(damaged)); store = new NotamStore(directory, 'production', () => NOTAM_NOW);
      await assert.rejects(store.restore(), /invalid-budget/); await store.close();
    }
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('checkpoint metadata corruption cannot silently advance freshness or collection continuity', async () => {
  const directory = await temporary(); let store = new NotamStore(directory, 'production', () => NOTAM_NOW);
  try {
    await store.restore(); await store.reserve('bulk');
    await store.publish({ schemaVersion: 2, environment: 'production', records: [notice()], complete: false,
      checkedAt: NOTAM_NOW - 180_000, watermark: NOTAM_NOW - 180_000, fullSyncAt: NOTAM_NOW - 180_000, baselineAt: NOTAM_NOW - 180_000 });
    await store.close(); const path = join(directory, 'current.json'), saved = JSON.parse(await readFile(path, 'utf8'));
    for (const damaged of [{ ...saved, checkedAt: NOTAM_NOW }, { ...saved, watermark: NOTAM_NOW },
      { ...saved, complete: true }, { ...saved, schemaVersion: 1 }]) {
      await writeFile(path, JSON.stringify(damaged));
      store = new NotamStore(directory, 'production', () => NOTAM_NOW);
      assert.equal(await store.restore(), undefined); assert.equal(store.recoveryError, 'invalid-checkpoint');
      assert.equal(store.nextBulkAt, NOTAM_NOW + NOTAM_DAY_MS); await store.close();
    }
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('quota write failure disables in-memory admission even if the file is subsequently repaired', async () => {
  const directory = await temporary(), store = new NotamStore(directory, 'production', () => NOTAM_NOW);
  let calls = 0;
  try {
    await store.restore(); const path = join(directory, 'budget.json'), saved = await readFile(path);
    await rm(path); await mkdir(path); await assert.rejects(store.reserve('delta'));
    await rm(path, { recursive: true }); await writeFile(path, saved);
    const source = createNotamSource({ environment: 'production', credentials, store, signal: new AbortController().signal,
      now: () => NOTAM_NOW, fetch: async () => { calls++; return token(); } });
    await assert.rejects(source.download('bulk', join(directory, 'source.tmp')), /storage-unavailable/);
    assert.equal(calls, 0);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('invalid delta windows and unavailable data slots do not even request a token', async () => {
  const directory = await temporary(); let now = NOTAM_NOW, calls = 0;
  const store = new NotamStore(directory, 'production', () => now);
  const source = createNotamSource({ environment: 'production', credentials, store, now: () => now, wait: async ms => { now += ms; },
    signal: new AbortController().signal, fetch: async () => { calls++; return token(); } });
  try {
    await store.restore();
    for (const since of [undefined, now + 1, now - NOTAM_DAY_MS - 1]) {
      await assert.rejects(source.download('delta', join(directory, 'source.tmp'), since), /delta-window-exceeded/);
    }
    await store.reserve('bulk'); now += 5000;
    await assert.rejects(source.download('bulk', join(directory, 'source.tmp')), /request-budget/);
    await assert.rejects(source.download('delta', join(directory, 'source.tmp'), now - 600_000), /request-budget/);
    assert.equal(calls, 0);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const reference of ['https://example.invalid/content', '/nmsapi/v1/content/%2e%2e%2fnotams', '/v1/content/fixture?location=TST', '//user:password@api-nms.aim.faa.gov/nmsapi/v1/content/fixture']) {
  test(`content references cannot escape the qualified endpoint: ${reference}`, async () => {
    const directory = await temporary(); let now = NOTAM_NOW, calls = 0;
    const store = new NotamStore(directory, 'production', () => now);
    try {
      await store.restore();
      const source = createNotamSource({ environment: 'production', credentials, store, now: () => now, wait: async ms => { now += ms; },
        signal: new AbortController().signal, fetch: async input => {
          calls++; now += 1001; const url = new URL(String(input)); assert.equal(url.origin, 'https://api-nms.aim.faa.gov');
          return url.pathname === '/v1/auth/token' ? token() : Response.json({ status: 'Success', data: { url: reference } });
        } });
      await assert.rejects(source.download('bulk', join(directory, 'source.tmp')), /invalid-content-reference/);
      assert.equal(calls, 2); assert.ok(store.nextBulkAt >= NOTAM_NOW + NOTAM_DAY_MS);
    } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
  });
}

test('closing the collector cancels its in-flight source request without requiring its parent to abort', { timeout: 5000 }, async () => {
  const directory = await temporary(), parent = new AbortController(); let started!: () => void, requestSignal: AbortSignal | undefined;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const service = createNotamService({ enabled: true, environment: 'production', credentials, directory }, {
    signal: parent.signal, now: () => NOTAM_NOW, fetch: async (_url, init) => {
      requestSignal = init!.signal!; started();
      return new Promise((_resolve, reject) => requestSignal!.addEventListener('abort', () => reject(requestSignal!.reason), { once: true }));
    },
  });
  try {
    await service.restore(); service.refresh(); await ready; await service.close();
    assert.equal(requestSignal?.aborted, true); assert.equal(parent.signal.aborted, false);
    const saved = JSON.parse(await readFile(join(directory, 'production', 'budget.json'), 'utf8'));
    assert.equal(saved.authAt, NOTAM_NOW + 180_000);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('invalid UTF-8 in a delta is rejected without silently rewriting source text', async () => {
  const directory = await temporary();
  try {
    const data = Buffer.from(JSON.stringify({ status: 'Success', data: { aixm: [aixm(notice({ text: 'UTF8_MARKER' }))] } }));
    const at = data.indexOf('UTF8_MARKER'); assert.ok(at > 0); data[at] = 0xc3; data[at + 1] = 0x28;
    const path = join(directory, 'source.tmp'), output = join(directory, 'parsed.tmp'); await writeFile(path, data);
    await assert.rejects(workerJob(new URL('../tools/info-server/notams-worker.ts', import.meta.url),
      { path, output, kind: 'delta', requestedAt: NOTAM_NOW }, new AbortController().signal), /invalid-envelope/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('XML member limits count UTF-8 bytes instead of allowing multi-byte text to multiply the bound', () => {
  let emitted = 0;
  const parser = createNotamXmlParser(() => { emitted++; }, { count: 1, snapshotAt: NOTAM_NOW });
  const xml = aixm(notice({ translations: Array.from({ length: 8 }, (_, i) => ({ type: `OTHER:${i}`, text: '空'.repeat(100_000) })) }));
  assert.throws(() => parser.write(xml), /member-limit/); assert.equal(emitted, 0);
});

for (const failure of ['http', 'stream', 'truncated', 'backoff'] as const) test(`bulk content recovery retries ${failure} within the original reference and admission`, async () => {
  const directory = await temporary(); let now = NOTAM_NOW, attempts = 0;
  const calls: { path: string; at: number }[] = [];
  const store = new NotamStore(directory, 'production', () => now);
  try {
    await store.restore();
    const source = createNotamSource({ environment: 'production', credentials, store, now: () => now,
      signal: new AbortController().signal, wait: async ms => { now += ms; }, fetch: async input => {
        const path = new URL(String(input)).pathname; calls.push({ path, at: now });
        if (path.endsWith('/token')) return token();
        if (path.endsWith('/il')) return Response.json({ status: 'Success', data: { url: '/v1/content/fixture' } });
        if (++attempts > 1) return new Response('complete source');
        if (failure === 'http') return new Response(null, { status: 500 });
        if (failure === 'backoff') return new Response(null, { status: 503, headers: { 'retry-after': '30' } });
        if (failure === 'truncated') return new Response('partial', { headers: { 'content-length': '100' } });
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('partial')); },
          pull(controller) { controller.error(new Error('fixture connection lost')); } }));
      } });
    const path = join(directory, 'bulk.tmp'), result = await source.download('bulk', path);
    assert.equal(await readFile(path, 'utf8'), 'complete source', 'retry replaces partial bytes');
    assert.equal(attempts, 2);
    assert.deepEqual(calls.map(call => call.path), ['/v1/auth/token', '/nmsapi/v1/notams/il', '/nmsapi/v1/content/fixture', '/nmsapi/v1/content/fixture']);
    assert.equal(result.requestedAt, calls[1]!.at);
    assert.equal(store.nextBulkAt, calls[1]!.at + NOTAM_DAY_MS);
    assert.ok(calls.slice(1).every((call, i) => call.at - calls[i]!.at >= 1000));
    if (failure === 'backoff') assert.ok(calls[3]!.at - calls[2]!.at >= 30_000);
    const budget = await readFile(join(directory, 'budget.json'), 'utf8');
    await store.close(); const restored = new NotamStore(directory, 'production', () => now);
    try { await restored.restore(); assert.equal(restored.nextBulkAt, store.nextBulkAt); assert.equal(await readFile(join(directory, 'budget.json'), 'utf8'), budget); }
    finally { await restored.close(); }
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const failure of [500, 401, 403, 404, 429, 503] as const) test(`bulk content HTTP ${failure} has bounded recovery and preserves long backoff`, async () => {
  const directory = await temporary(); let now = NOTAM_NOW, attempts = 0, references = 0;
  const store = new NotamStore(directory, 'production', () => now);
  try {
    await store.restore();
    const source = createNotamSource({ environment: 'production', credentials, store, now: () => now,
      signal: new AbortController().signal, wait: async ms => { now += ms; }, fetch: async input => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/token')) return token();
        if (path.endsWith('/il')) { references++; return Response.json({ status: 'Success', data: { url: '/v1/content/fixture' } }); }
        attempts++; return new Response(null, { status: failure, headers: { 'retry-after': '600' } });
      } });
    await assert.rejects(source.download('bulk', join(directory, 'bulk.tmp')));
    assert.equal(attempts, failure === 500 ? 3 : 1);
    assert.equal(references, 1);
    assert.ok(store.nextBulkAt > now + 23 * 3600_000);
    if ([429, 503].includes(failure)) assert.ok(store.nextAnyAt >= now + 600_000);
    await assert.rejects(source.download('bulk', join(directory, 'later.tmp')), /request-budget/);
    assert.equal(references, 1);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('local content persistence failures and shutdown cannot start content retries', async () => {
  const directory = await temporary(); let now = NOTAM_NOW, attempts = 0;
  const lifetime = new AbortController(), store = new NotamStore(directory, 'production', () => now);
  try {
    await store.restore();
    const source = createNotamSource({ environment: 'production', credentials, store, now: () => now,
      signal: lifetime.signal, wait: async ms => { now += ms; }, fetch: async input => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/token')) return token();
        if (path.endsWith('/il')) return Response.json({ status: 'Success', data: { url: '/v1/content/fixture' } });
        attempts++; return new Response('source');
      } });
    await assert.rejects(source.download('bulk', join(directory, 'missing', 'bulk.tmp')), { code: 'ENOENT' });
    assert.equal(attempts, 1);
    now = store.nextBulkAt; lifetime.abort();
    await assert.rejects(source.download('bulk', join(directory, 'bulk.tmp')), { name: 'AbortError' });
    assert.equal(attempts, 1);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
