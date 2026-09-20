import assert from 'node:assert/strict';
import test from 'node:test';

import type { MetarFeature } from '@zlayer/contracts';
import { mergeMetarsIntoAirports } from '@zlayer/domain';
import { MetarClient, METAR_REFRESH_MS } from '../src/layers/metar-taf/metar/client.js';
import { metarReportSummary } from '../src/layers/metar-taf/metar/summary.js';

const endpoint = new URL('https://example.test/weather');
const signal = () => new AbortController().signal;
const report = (id: string, obsTime = '2026-09-15T17:00:00Z'): MetarFeature => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [-122, 37] },
  properties: { id, obsTime, fltcat: 'VFR' },
});
const response = (...features: MetarFeature[]) => Response.json({ type: 'FeatureCollection', features });
const ids = (input: Parameters<typeof fetch>[0]) => new URL(String(input)).searchParams.get('ids')!.split(',');

test('fetches only requested stations, caches overlaps and empty results, and refreshes after one minute', async () => {
  let now = 1_000;
  const requested: string[][] = [];
  const client = new MetarClient(endpoint, {
    now: () => now,
    fetch: async (input) => {
      requested.push(ids(input));
      return response(...ids(input).filter((id) => id !== 'KEMPTY').map((id) => report(id)));
    },
  });
  await client.refresh(['KSFO', 'KHWD', 'KEMPTY'], signal());
  now += 10_000;
  await client.refresh(['KHWD', 'KEMPTY', 'KOAK'], signal());
  await client.refresh(['KSFO'], signal());
  assert.deepEqual(requested, [['KSFO', 'KHWD', 'KEMPTY'], ['KOAK']]);
  assert.equal(client.snapshot().metars.features.length, 3);
  now += METAR_REFRESH_MS;
  await client.refresh(['KOAK'], signal());
  assert.deepEqual(requested.at(-1), ['KOAK']);
  assert.equal(client.snapshot().metars.features.length, 3, 'off-screen reports remain cached');
});

test('retains the newest observation after older or empty responses and restores it after reload', async () => {
  let saved: string | null = null;
  const storage = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } };
  let now = 100_000;
  let next = report('KSFO');
  let empty = false;
  const client = new MetarClient(endpoint, {
    now: () => now, storage,
    fetch: async () => empty ? new Response(null, { status: 204 }) : response(next),
  });
  await client.refresh(['KSFO'], signal());
  now += METAR_REFRESH_MS;
  next = report('KSFO', '2026-09-15T16:00:00Z');
  await client.refresh(['KSFO'], signal());
  assert.equal(client.snapshot().stations.get('KSFO')?.report?.properties.obsTime, '2026-09-15T17:00:00Z');
  now += METAR_REFRESH_MS;
  empty = true;
  await client.refresh(['KSFO'], signal());
  const entry = client.snapshot().stations.get('KSFO');
  assert.equal(entry?.missing, true);
  assert.equal(entry?.report?.properties.obsTime, '2026-09-15T17:00:00Z');
  const restored = new MetarClient(endpoint, { storage });
  assert.deepEqual(restored.snapshot().metars, client.snapshot().metars);
  assert.equal(restored.snapshot().stations.get('KSFO')?.checkedAt, undefined, 'reload revalidates');
});

test('cache selection and airport enrichment agree on station aliases and mixed observation time formats', async () => {
  const latest = Date.parse('2026-09-15T18:00:00Z');
  const reports: MetarFeature[] = [
    { ...report('KSFO'), properties: { id: ' ksfo ', obsTime: (latest - 60_000) / 1000, rawOb: 'OLDER' } },
    { ...report('KSFO'), properties: { id: ' ', icaoId: ' ksfo ', obsTime: latest, rawOb: 'LATEST' } },
    { ...report('KSFO'), properties: { id: 'KSFO', obsTime: '2026-09-15T17:00:00Z', rawOb: 'OLDEST' } },
  ];
  const client = new MetarClient(endpoint, { now: () => latest, fetch: async () => response(...reports) });
  await client.refresh([' ksfo '], signal());
  const snapshot = client.snapshot();
  assert.deepEqual([...snapshot.stations.keys()], ['KSFO']);
  const cached = snapshot.stations.get('KSFO');
  assert.equal(cached?.report?.properties.rawOb, 'LATEST');
  assert.equal(metarReportSummary(cached, latest + 60_000).age, '1m old');
  const airport = { type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [-122, 37] as [number, number] },
    properties: { icaoId: ' ksfo ', faaId: 'SFO' } };
  for (const features of [reports, snapshot.metars.features]) {
    const merged = mergeMetarsIntoAirports({ type: 'FeatureCollection', features: [airport],
      meta: { revision: 'test', layer: 'airports', returned: 1, truncated: false } }, { type: 'FeatureCollection', features });
    assert.equal(merged.features[0]!.properties.rawMetar, 'LATEST');
    assert.equal(merged.features[0]!.properties.metarObservedAt, '2026-09-15T18:00:00.000Z');
  }
});

test('retries transient errors once, preserves failed batches, and throttles failures for a minute', async () => {
  let fail = false;
  let now = 1_000;
  let attempts = 0;
  const client = new MetarClient(endpoint, {
    now: () => now, retryDelayMs: 0,
    fetch: async (input) => {
      attempts++;
      if (fail && ids(input).includes('K000')) return new Response(null, { status: 504 });
      return response(...ids(input).map((id) => report(id)));
    },
  });
  const stations = Array.from({ length: 101 }, (_, i) => `K${String(i).padStart(3, '0')}`);
  await client.refresh(stations, signal());
  assert.equal(attempts, 2);
  now += METAR_REFRESH_MS;
  fail = true;
  await client.refresh(stations, signal());
  assert.equal(attempts, 5);
  const snapshot = client.snapshot();
  assert.equal(snapshot.metars.features.length, 101);
  assert.match(snapshot.stations.get('K000')?.error ?? '', /504/);
  assert.equal(snapshot.stations.get('K100')?.error, undefined);
  assert.equal(snapshot.stations.get('K000')?.checkedAt, 1_000);
  await client.refresh(['K000'], signal());
  assert.equal(attempts, 5, 'panning must not hammer a failed station');
});

test('does not retry rate-limit/client errors or malformed documents', async () => {
  for (const status of [400, 429, 200]) {
    let attempts = 0;
    const client = new MetarClient(endpoint, {
      retryDelayMs: 0,
      fetch: async () => { attempts++; return new Response('{}', { status }); },
    });
    await client.refresh(['KSFO'], signal());
    assert.equal(attempts, 1);
    assert.ok(client.snapshot().stations.get('KSFO')?.error);
  }
});

test('bounds concurrency and cancels obsolete requests without starting queued batches', async () => {
  let calls = 0;
  const controller = new AbortController();
  const client = new MetarClient(endpoint, {
    fetch: async (_input, options) => {
      calls++;
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
      });
    },
  });
  const pending = client.refresh(Array.from({ length: 301 }, (_, i) => `K${i}`), controller.signal);
  assert.equal(calls, 2);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 2);
  assert.equal(client.snapshot().stations.size, 0, 'cancellation is not a station failure');
});

test('times out a hanging request, retries once, and releases the refresh', async () => {
  let calls = 0;
  // AbortSignal.timeout uses an unreferenced timer in Node.
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    const client = new MetarClient(endpoint, {
      timeoutMs: 5, retryDelayMs: 0,
      fetch: async (_input, options) => {
        calls++;
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
        });
      },
    });
    await client.refresh(['KSFO'], signal());
    assert.equal(calls, 2);
    assert.ok(client.snapshot().stations.get('KSFO')?.error);
  } finally { clearInterval(keepAlive); }
});

test('recovers from network failure and caches only requested IDs from a full static snapshot', async () => {
  let calls = 0;
  const client = new MetarClient(endpoint, {
    retryDelayMs: 0,
    fetch: async () => {
      if (++calls === 1) throw new TypeError('Failed to fetch');
      return response(report('KSFO'), report('KJFK'));
    },
  });
  await client.refresh(['KSFO'], signal());
  assert.equal(calls, 2);
  assert.deepEqual([...client.snapshot().stations.keys()], ['KSFO']);
});

test('storage failures and invalid persisted data do not prevent live observations', async () => {
  for (const getItem of [() => '{broken', () => { throw new Error('denied'); }]) {
    const client = new MetarClient(endpoint, {
      storage: { getItem, setItem: () => { throw new Error('quota'); } },
      fetch: async () => response(report('KSFO')),
    });
    await client.refresh(['KSFO'], signal());
    assert.equal(client.snapshot().metars.features.length, 1);
  }
});

test('airport summary distinguishes observation age, successful checks, and stale/failed reports', () => {
  const now = Date.parse('2026-09-15T17:15:00Z');
  const entry = { report: report('KSFO'), checkedAt: now };
  assert.deepEqual(metarReportSummary(entry, now), {
    cached: false, label: 'Updated', age: '15m old', details: ['Checked now'],
  });
  assert.deepEqual(metarReportSummary(entry, now + 59_999).details, ['Checked now']);
  assert.deepEqual(metarReportSummary(entry, now + 60_000).details, ['Checked 1m ago']);
  assert.equal(metarReportSummary(entry, now + 45 * 60_000).age, '1h old');
  assert.deepEqual(metarReportSummary({ checkedAt: now, missing: true }, now), {
    cached: false, label: 'No report', age: undefined,
    details: ['No recent report returned', 'Checked now'],
  });
  assert.equal(metarReportSummary(entry, now + 120_000).cached, true);
  assert.equal(metarReportSummary({ report: report('KSFO') }, now).cached, true);
  assert.ok(metarReportSummary({ ...entry, error: '504' }, now).details.includes('Refresh unavailable'));
  assert.equal(metarReportSummary({ ...entry, missing: true }, now).label, 'Cached report');
});
