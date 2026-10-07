import assert from 'node:assert/strict';
import test from 'node:test';
import { MetarClient } from '../src/layers/metar-taf/metar/client';
import { TafClient } from '../src/layers/metar-taf/taf/client';
import { METAR_CACHE_WEIGHT, SAVED_REPORT_BYTES, TAF_CACHE_WEIGHT, reportWeight } from '../src/layers/metar-taf/cache-budget';

const origin = new URL('https://test/weather');
const initial = Date.parse('2026-10-06T12:00:00Z');
const signal = new AbortController().signal;
const metar = (id: string, raw = 'VALID') => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [-122, 37] },
  properties: { id, obsTime: initial, rawOb: raw } });
const taf = (id: string, raw = 'VALID') => ({ icaoId: id, issueTime: new Date(initial).toISOString(),
  validTimeFrom: initial / 1000, validTimeTo: initial / 1000 + 86400, rawTAF: raw, fcsts: [] });
for (const product of ['metar', 'taf'] as const) {
  const make = product === 'metar' ? metar : taf;
  const envelope = (reports: object[]) => product === 'metar' ? { type: 'FeatureCollection', features: reports } : reports;
  const refresh = (client: MetarClient | TafClient, id: string) => client instanceof MetarClient ? client.refresh([id], signal) : client.refresh(id, signal);
  const create = (options: ConstructorParameters<typeof TafClient>[1]) => product === 'metar' ? new MetarClient(origin, options) : new TafClient(origin, options);

  test(`${product} rejects streamed overflow and complex replacements, retaining the last successful report`, async () => {
    let time = initial, next = () => Response.json(envelope([make('KAAA')]));
    const client = create({ now: () => time, fetch: async () => next() });
    await refresh(client, 'KAAA');
    const first = client.get('KAAA')!;
    let cancelled = false;
    next = () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
      cancel() { cancelled = true; } }));
    time += 5 * 60_000; await refresh(client, 'KAAA');
    assert.ok(cancelled);
    assert.match(client.get('KAAA')!.error!, /response limit/);
    next = () => Response.json(envelope([make('KAAA', 'x'.repeat(128 * 1024))]));
    time += 5 * 60_000; await refresh(client, 'KAAA');
    assert.match(client.get('KAAA')!.error!, /memory limit/);
    assert.equal(client.get('KAAA')!.report, first.report);
    assert.equal(client.get('KAAA')!.checkedAt, first.checkedAt);
    next = () => Response.json(envelope([{ ...make('KAAA'), unused: Array.from({ length: 3000 }, () => ({})) }]));
    time += 5 * 60_000; await refresh(client, 'KAAA');
    assert.match(client.get('KAAA')!.error!, /memory limit/);
  });

  test(`${product} rejects oversized saved text before parsing and oversized individual saved reports`, () => {
    for (const saved of [' '.repeat(SAVED_REPORT_BYTES / 2 + 1) + JSON.stringify(envelope([make('KAAA')])),
      JSON.stringify(envelope([make('KAAA', 'x'.repeat(128 * 1024))]))]) {
      const client = create({ storage: { getItem: () => saved, setItem() {} } });
      assert.equal(client.get('KAAA'), undefined);
    }
  });

  test(`${product} bounds accumulated reports and saved projection without evicting accepted stations`, async () => {
    let saved = '', weight = 0, failed = false, lastAccepted = '';
    const client = create({ now: () => initial, storage: { getItem: () => null, setItem(_key, text) { saved = text; } },
      fetch: async input => Response.json(envelope([make(new URL(String(input)).searchParams.get('ids')!, 'x'.repeat(60_000))])) });
    for (let i = 0; i < 160; i++) {
      const id = `K${String(i).padStart(3, '0')}`;
      await refresh(client, id);
      const entry = client.get(id)!;
      if (entry.report) { weight += reportWeight(entry.report); lastAccepted = id; }
      else { assert.match(entry.error!, /cache exceeds/); failed = true; break; }
    }
    assert.ok(failed);
    assert.ok(weight <= (product === 'metar' ? METAR_CACHE_WEIGHT : TAF_CACHE_WEIGHT));
    assert.ok(client.get('K000')?.report, 'admission cannot silently discard another consumer’s report');
    assert.ok(saved.length * 2 <= SAVED_REPORT_BYTES);
    const restored = create({ storage: { getItem: () => saved, setItem() {} } });
    assert.ok(restored.get(lastAccepted)?.report, 'recent complete reports survive optional persistence');
  });

  test(`${product} backs off denied saves and retries the latest changed reports after recovery and clock rollback`, async () => {
    let time = initial, writes = 0, denied = true, raw = 'FIRST', saved = '';
    const client = create({ now: () => time, fetch: async () => Response.json(envelope([make('KAAA', raw)])),
      storage: { getItem: () => null, setItem(_key, text) { writes++; if (denied) throw new Error('quota'); saved = text; } } });
    await refresh(client, 'KAAA');
    time += 5 * 60_000; await refresh(client, 'KAAA');
    assert.equal(writes, 2, 'second denial doubles the retry interval');
    time += 5 * 60_000; raw = 'LATEST'; await refresh(client, 'KAAA');
    assert.equal(writes, 2, 'changed content does not bypass storage backoff');
    time += 5 * 60_000; denied = false; await refresh(client, 'KAAA');
    assert.equal(writes, 3); assert.ok(saved.includes('LATEST'));
    time += 5 * 60_000; denied = true; raw = 'DENIED'; await refresh(client, 'KAAA');
    time -= 60 * 60_000; denied = false; raw = 'ROLLBACK'; await refresh(client, 'KAAA');
    assert.equal(writes, 5); assert.ok(saved.includes('ROLLBACK'));
  });
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
for (const product of ['metar', 'taf'] as const) test(`${product} shares normalized nearby demand and admits station/area reads together`, async () => {
  const requests: { signal: AbortSignal; finish: () => void }[] = [];
  const options = { fetch: (async (_url, init) => new Promise<Response>(resolve => {
    requests.push({ signal: init!.signal!, finish: () => resolve(new Response(null, { status: 204 })) });
  })) as typeof fetch };
  const endpoint = new URL(`https://test/${product}`);
  const client = product === 'metar' ? new MetarClient(endpoint, options) : new TafClient(endpoint, options);
  const first = new AbortController(), second = new AbortController();
  const cancelled = assert.rejects(client.refreshNearby([-118, 34], first.signal), { name: 'AbortError' });
  const shared = client.refreshNearby([242, 34], second.signal);
  const station = (id: string) => client instanceof MetarClient ? client.refresh([id], second.signal) : client.refresh(id, second.signal);
  const direct = station('KAAA'), queued = station('KBBB');
  await flush(); assert.equal(requests.length, 2);
  first.abort(); await cancelled;
  assert.equal(requests[0]!.signal.aborted, false, 'remaining consumer owns the area request');
  requests[0]!.finish(); requests[1]!.finish(); await flush();
  assert.equal(requests.length, 3, 'queued station starts when a slot is released');
  requests[2]!.finish(); await Promise.all([shared, direct, queued]);
  assert.ok(client.nearbyStatus([-118, 34])?.checkedAt);
});

test('TAF station sharing normalizes identifiers and last-user cancellation prevents publication', async () => {
  let calls = 0, requestSignal: AbortSignal | undefined, finish!: () => void;
  const client = new TafClient(new URL('https://test/taf'), { fetch: (async (_url, init) => {
    calls++; requestSignal = init!.signal!;
    await new Promise<void>(resolve => { finish = resolve; });
    return new Response(null, { status: 204 });
  }) as typeof fetch });
  const a = new AbortController(), b = new AbortController();
  const one = assert.rejects(client.refresh(' kaaa ', a.signal), { name: 'AbortError' });
  const two = assert.rejects(client.refresh('KAAA', b.signal), { name: 'AbortError' });
  await flush(); assert.equal(calls, 1);
  a.abort(); assert.equal(requestSignal!.aborted, false);
  b.abort(); assert.equal(requestSignal!.aborted, true);
  await Promise.all([one, two]); finish(); await flush(); assert.equal(client.get('KAAA'), undefined);
});
