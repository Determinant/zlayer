import assert from 'node:assert/strict';
import test from 'node:test';
import { isTafReport, type TafReport } from '@zlayer/contracts';
import { TafClient, TAF_REFRESH_MS } from '../src/layers/metar-taf/taf/client';

const endpoint = new URL('https://app.test/weather/tafs.json');
const now = Date.parse('2026-09-17T19:00:00Z');
const report = (fields: Partial<TafReport> = {}): TafReport => ({ icaoId: 'KSFO', issueTime: '2026-09-17T18:00:00Z',
  validTimeFrom: now / 1000, validTimeTo: now / 1000 + 86400, rawTAF: 'TAF KSFO TEST', fcsts: [], ...fields });
const signal = () => new AbortController().signal;

test('requests only the selected station, selects the latest amendment, and throttles successful checks', async () => {
  let time = now;
  const calls: URL[] = [];
  const latest = report({ dbPopTime: '2026-09-17T18:05:00Z', rawTAF: 'TAF AMD KSFO TEST' });
  const client = new TafClient(endpoint, { now: () => time, fetch: async (input, init) => {
    calls.push(new URL(String(input)));
    assert.equal(init?.cache, 'no-store');
    return Response.json([report({ icaoId: 'KJFK' }), report(), latest]);
  } });
  await client.refresh(' ksfo ', signal());
  assert.equal(calls[0]?.pathname, '/weather/tafs.json');
  assert.deepEqual([...calls[0]!.searchParams], [['ids', 'KSFO'], ['format', 'json']]);
  assert.equal(client.get('KSFO')?.report?.rawTAF, latest.rawTAF);
  await client.refresh('KSFO', signal());
  assert.equal(calls.length, 1);
  time += TAF_REFRESH_MS;
  await client.refresh('KSFO', signal());
  assert.equal(calls.length, 2);
  await client.refresh('INVALID,ALL', signal());
  assert.equal(calls.length, 2);
});

test('offline and malformed responses preserve the cached forecast without reporting a successful refresh', async () => {
  let time = now;
  let response = Response.json([report()]);
  const saved = new Map<string, string>();
  const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); } };
  const client = new TafClient(endpoint, { now: () => time, storage, fetch: async () => response.clone() });
  await client.refresh('KSFO', signal());
  time += TAF_REFRESH_MS;
  for (const badResponse of [new Response(null, { status: 503 }), Response.json([{ rawTAF: 'invalid' }]), new Response('<html>app shell</html>')]) {
    response = badResponse;
    await client.refresh('KSFO', signal());
    assert.equal(client.get('KSFO')?.checkedAt, now);
    assert.ok(client.get('KSFO')?.error);
    assert.equal(client.get('KSFO')?.report?.rawTAF, report().rawTAF);
  }
  const restored = new TafClient(endpoint, { storage });
  assert.equal(restored.get('KSFO')?.checkedAt, undefined);
  assert.equal(restored.get('KSFO')?.report?.rawTAF, report().rawTAF);
});

test('204 and empty arrays mean no TAF; a missing or older report cannot erase a newer cached amendment', async () => {
  let time = now;
  let response = new Response(null, { status: 204 });
  const client = new TafClient(endpoint, { now: () => time, fetch: async () => response.clone() });
  const refresh = async () => { time += TAF_REFRESH_MS; await client.refresh('KSFO', signal()); };
  await refresh();
  assert.equal(client.get('KSFO')?.missing, true);
  assert.equal(client.get('KSFO')?.error, undefined);
  response = Response.json([report()]); await refresh();
  response = Response.json([]); await refresh();
  assert.equal(client.get('KSFO')?.missing, true);
  assert.equal(client.get('KSFO')?.report?.issueTime, report().issueTime);
  response = Response.json([report({ issueTime: '2026-09-17T12:00:00Z' })]); await refresh();
  assert.equal(client.get('KSFO')?.missing, true);
  assert.equal(client.get('KSFO')?.report?.issueTime, report().issueTime);
  response = Response.json([report({ issueTime: '2026-09-17T19:00:00Z', rawTAF: 'TAF KSFO CNL' })]); await refresh();
  assert.equal(client.get('KSFO')?.report?.rawTAF, 'TAF KSFO CNL');
});

test('cancelled requests cannot publish a report after the selected airport changes', async () => {
  const controller = new AbortController();
  const client = new TafClient(endpoint, { fetch: async () => { controller.abort(); return Response.json([report()]); } });
  await assert.rejects(client.refresh('KSFO', controller.signal), { name: 'AbortError' });
  assert.equal(client.get('KSFO'), undefined);
});

test('validates forecast units and nested structure, while tolerating unused upstream fields', () => {
  assert.ok(isTafReport({ ...report(), unused: 'allowed' }));
  for (const fields of [{ issueTime: 'invalid' }, { validTimeTo: NaN }, { rawTAF: '' },
    { fcsts: [{ timeFrom: now / 1000, timeTo: now / 1000 + 3600, clouds: [{ cover: 'BKN', base: '800' }] }] }]) {
    assert.equal(isTafReport({ ...report(), ...fields }), false);
  }
});

test('one bounded nearby query caches all alternatives, chooses amendments and reuses them after reload', async () => {
  const point: [number, number] = [-118.45, 34.02];
  const lax = report({ icaoId: 'KLAX', lat: 33.94, lon: -118.40 });
  const bur = report({ icaoId: 'KBUR', lat: 34.20, lon: -118.36 });
  const amended = { ...lax, dbPopTime: '2026-09-17T18:05:00Z', rawTAF: 'TAF AMD KLAX TEST' };
  const saved = new Map<string, string>();
  const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); } };
  let calls = 0;
  const client = new TafClient(endpoint, { now: () => now, storage, fetch: async (input, init) => {
    calls++;
    const params = new URL(String(input)).searchParams;
    assert.equal(params.get('ids'), null);
    assert.equal(params.get('format'), 'json');
    const [south, west, north, east] = params.get('bbox')!.split(',').map(Number);
    assert.ok(south! < 34.02 && north! > 34.02 && west! < -118.45 && east! > -118.45);
    assert.equal(init?.cache, 'no-store');
    return Response.json([bur, lax, amended, report({ lat: 37.62, lon: -122.38 })]);
  } });
  await client.refreshNearby(point, signal());
  assert.deepEqual(client.nearby(point).map(station => station.stationId), ['KLAX', 'KBUR']);
  assert.equal(client.get('KLAX')?.report?.rawTAF, amended.rawTAF);
  assert.equal(client.get('KSFO'), undefined, 'bounding-box corners and unexpected distant reports are excluded');
  assert.equal(client.nearbyStatus(point)?.checkedAt, now);
  await client.refreshNearby(point, signal());
  await client.refresh('KBUR', signal());
  assert.equal(calls, 1, 'nearby and direct requests share station freshness');
  const restored = new TafClient(endpoint, { storage, now: () => now });
  assert.deepEqual(restored.nearby(point).map(station => station.stationId), ['KLAX', 'KBUR']);
  assert.equal(restored.get('KBUR')?.checkedAt, undefined);
  assert.equal(restored.nearbyStatus(point), undefined);
});

test('failed, missing and older nearby results preserve saved reports without hiding refresh failures', async () => {
  const point: [number, number] = [-122.38, 37.62];
  const forecast = report({ lat: 37.62, lon: -122.38 });
  let time = now;
  let response = Response.json([forecast]);
  const client = new TafClient(endpoint, { now: () => time, fetch: async () => response.clone() });
  await client.refreshNearby(point, signal());
  time += TAF_REFRESH_MS;
  for (const bad of [new Response(null, { status: 503 }), Response.json([{ rawTAF: 'bad' }])]) {
    response = bad;
    await client.refreshNearby(point, signal());
    assert.equal(client.nearbyStatus(point)?.checkedAt, now);
    assert.ok(client.nearbyStatus(point)?.error);
    assert.equal(client.get('KSFO')?.checkedAt, now);
    assert.deepEqual(client.get('KSFO')?.report, forecast);
  }
  response = new Response(null, { status: 204 });
  await client.refreshNearby(point, signal());
  assert.equal(client.nearbyStatus(point)?.error, undefined);
  assert.equal(client.get('KSFO')?.missing, true);
  assert.deepEqual(client.get('KSFO')?.report, forecast);
  time += TAF_REFRESH_MS;
  response = Response.json([{ ...forecast, issueTime: '2026-09-17T12:00:00Z' }]);
  await client.refreshNearby(point, signal());
  assert.deepEqual(client.get('KSFO')?.report, forecast);
  time += TAF_REFRESH_MS;
  response = Response.json([{ ...forecast, issueTime: '2026-09-17T19:00:00Z', rawTAF: 'TAF KSFO CNL' }]);
  await client.refreshNearby(point, signal());
  assert.equal(client.nearby(point).length, 0, 'a cancelled forecast cannot remain a selectable nearby forecast');
});

test('a cancelled dateline search cannot publish a partial result', async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = new TafClient(endpoint, { fetch: async () => {
    if (++calls === 2) controller.abort();
    return Response.json([report({ icaoId: 'PADK', lat: 51, lon: -179.9 })]);
  } });
  await assert.rejects(client.refreshNearby([179.8, 51], controller.signal), { name: 'AbortError' });
  assert.equal(calls, 2);
  assert.equal(client.get('PADK'), undefined);
  assert.equal(client.nearbyStatus([179.8, 51]), undefined);
});

test('a failed direct request cannot discard a newer forecast received by a nearby query', async () => {
  let fail!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { fail = resolve; });
  const latest = report({ lat: 37.62, lon: -122.38, rawTAF: 'TAF AMD KSFO TEST' });
  const client = new TafClient(endpoint, { now: () => now, fetch: async input =>
    new URL(String(input)).searchParams.has('ids') ? pending : Response.json([latest]) });
  const direct = client.refresh('KSFO', signal());
  await client.refreshNearby([-122.38, 37.62], signal());
  fail(new Response(null, { status: 503 }));
  await direct;
  assert.deepEqual(client.get('KSFO')?.report, latest);
  assert.equal(client.get('KSFO')?.checkedAt, now);
  assert.match(client.get('KSFO')!.error!, /503/);
});
