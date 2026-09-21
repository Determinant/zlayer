import assert from 'node:assert/strict';
import test from 'node:test';
import type { MetarFeature } from '@zlayer/contracts';
import { hasCurrentReport, nearbyStationBoxes, nearbyStations, stationChoices } from '../src/layers/metar-taf/nearby-stations';
import { MetarClient, METAR_REFRESH_MS } from '../src/layers/metar-taf/metar/client';

const now = Date.parse('2026-09-17T18:00:00Z');
const point: [number, number] = [-118.45, 34.02];
const signal = () => new AbortController().signal;
const report = (id: string, lon: number, lat: number, time = now): MetarFeature => ({
  type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: { id, obsTime: time / 1000, rawOb: `METAR ${id} TEST`, fltcat: 'VFR' },
});
const lax = report('KLAX', -118.40, 33.94);
const bur = report('KBUR', -118.36, 34.20);
const response = (...features: MetarFeature[]) => Response.json({ type: 'FeatureCollection', features });

test('nearby METARs prefer current observations, then distance, retaining labeled stale alternatives', () => {
  const nil = report('KNIL', ...point);
  nil.properties.rawOb = 'METAR KNIL NIL';
  const stations = nearbyStations(point, [bur, lax, report('KOLD', -118.45, 34.021, now - 3 * 3600_000),
    nil, report('KSBA', -119.84, 34.43), report('KUNK', NaN, 34)], now);
  assert.deepEqual(stations.map(station => station.stationId), ['KLAX', 'KBUR', 'KOLD']);
  assert.equal(stations[0]?.direction, 'SE');
  assert.ok(stations[0]!.distanceNm > 5 && stations[0]!.distanceNm < 6);
  assert.equal(stations[1]?.direction, 'N');
  assert.equal(hasCurrentReport(stations[2]?.report, now), false);
  assert.equal(hasCurrentReport(nil, now), false);
  assert.equal(hasCurrentReport(report('KUNK', ...point, 0), now), false);
  assert.equal(hasCurrentReport(lax, now + 2 * 3600_000), true);
  assert.equal(hasCurrentReport(lax, now + 2 * 3600_000 + 1), false);
});

test('nearby station boxes cover dateline, world copies, polar positions and invalid geometry', () => {
  const boxes = nearbyStationBoxes([179.8, 51]).map(box => box.split(',').map(Number));
  assert.equal(boxes.length, 2);
  assert.equal(boxes[0]![3], 180);
  assert.equal(boxes[1]![1], -180);
  assert.ok(boxes.every(([south, west, north, east]) => south! < 51 && north! > 51 && west! < east!));
  assert.deepEqual(nearbyStationBoxes([539.8, 51]), nearbyStationBoxes([179.8, 51]));
  assert.deepEqual(nearbyStationBoxes([0, 89.9])[0]!.split(',').map(Number).slice(1), [-180, 90, 180]);
  assert.deepEqual(nearbyStationBoxes([NaN, 37]), []);
  assert.deepEqual(nearbyStationBoxes([0, 91]), []);
});

test('station choices retain stale local METARs and rank the same currentness and distance as nearby reports', () => {
  const own = report('KSMO', ...point, now - 2.5 * 3600_000);
  const stale = report('KOLD', -118.40, 33.94, now - 4 * 3600_000);
  const nearby = nearbyStations(point, [stale, lax, own], now);
  const choices = stationChoices(own, nearby, now);
  assert.deepEqual(choices.map(station => station.stationId), ['KLAX', 'KSMO', 'KOLD']);
  assert.equal(choices[1]?.distanceNm, 0);
  assert.deepEqual(stationChoices(own, nearby, now + 3 * 3600_000).map(station => station.stationId),
    ['KSMO', 'KLAX', 'KOLD'], 'the local observation defaults first when all reports are stale');
  assert.equal(stationChoices(report('KSMO', ...point), nearby, now)[0]?.stationId, 'KSMO');
  assert.deepEqual(stationChoices(undefined, nearby, now), nearby);
  const nil = { ...own, properties: { ...own.properties, rawOb: 'METAR KSMO NIL' } };
  assert.deepEqual(stationChoices(nil, nearby, now).map(station => station.stationId), ['KLAX', 'KOLD']);
});

test('nearby discovery filters the radius, deduplicates newest reports, shares the station cache and persists offline choices', async () => {
  let saved: string | null = null, updates = 0;
  const calls: URL[] = [];
  const storage = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } };
  const client = new MetarClient(new URL('https://example.test/weather?ids=OLD'), {
    now: () => now, storage, fetch: async (input, init) => {
      assert.equal(init?.cache, 'no-store');
      calls.push(new URL(String(input)));
      return response(bur, lax, report('KLAX', -118.40, 33.94, now - 60_000), report('KSBA', -119.84, 34.43));
    },
  });
  const unsubscribe = client.subscribe(() => { updates++; });
  await client.refreshNearby(point, signal());
  assert.equal(calls[0]?.searchParams.has('ids'), false);
  assert.equal(calls[0]?.searchParams.get('bbox'), nearbyStationBoxes(point)[0]);
  assert.equal(calls[0]?.searchParams.get('format'), 'geojson');
  assert.equal(calls[0]?.searchParams.get('hours'), '2');
  assert.deepEqual(client.get('KLAX')?.report, lax);
  assert.equal(client.get('KSBA'), undefined);
  assert.deepEqual(client.nearby(point).map(station => station.stationId), ['KLAX', 'KBUR']);
  assert.deepEqual(client.nearby(point, 'KLAX').map(station => station.stationId), ['KBUR']);
  await client.refreshNearby(point, signal());
  await client.refresh(['KLAX'], signal());
  assert.equal(calls.length, 1, 'the map and card share successful checks');
  assert.equal(updates, 1);
  unsubscribe();
  const restored = new MetarClient(new URL('https://example.test/weather'), { now: () => now, storage });
  assert.deepEqual(restored.nearby(point), client.nearby(point));
  assert.equal(restored.get('KLAX')?.checkedAt, undefined);
  assert.equal(restored.nearbyStatus(point), undefined);
});

test('empty, older and failed nearby refreshes retain observations without asserting freshness', async () => {
  let clock = now, mode = 'reports', calls = 0;
  const client = new MetarClient(new URL('https://example.test/weather'), {
    now: () => clock, retryDelayMs: 0, fetch: async () => {
      calls++;
      if (mode === 'failure') return new Response(null, { status: 503 });
      if (mode === 'empty') return new Response(null, { status: 204 });
      return response(mode === 'older' ? report('KLAX', -118.40, 33.94, now - 60_000) : lax);
    },
  });
  await client.refreshNearby(point, signal());
  for (mode of ['older', 'empty']) {
    clock += METAR_REFRESH_MS;
    await client.refreshNearby(point, signal());
    assert.deepEqual(client.get('KLAX')?.report, lax);
    assert.equal(client.get('KLAX')?.missing, true);
  }
  mode = 'failure'; clock += METAR_REFRESH_MS;
  await client.refreshNearby(point, signal());
  assert.match(client.nearbyStatus(point)?.error ?? '', /503/);
  assert.deepEqual(client.get('KLAX')?.report, lax);
  const count = calls;
  await client.refreshNearby(point, signal());
  assert.equal(calls, count, 'failed areas are throttled for one minute');
  mode = 'reports'; clock += METAR_REFRESH_MS;
  await client.refreshNearby(point, signal());
  assert.equal(client.nearbyStatus(point)?.error, undefined);
  assert.equal(client.get('KLAX')?.missing, false);
});

test('dateline discovery is atomic when a later box fails or the airport selection is cancelled', async () => {
  for (const cancel of [true, false]) {
    const controller = new AbortController();
    let calls = 0;
    const client = new MetarClient(new URL('https://example.test/weather'), { now: () => now,
      fetch: async () => {
        if (++calls === 1) return response(report('PADK', -179.9, 51));
        if (cancel) { controller.abort(); controller.signal.throwIfAborted(); }
        return new Response(null, { status: 400 });
      },
    });
    const pending = client.refreshNearby([179.8, 51], controller.signal);
    if (cancel) await assert.rejects(pending, { name: 'AbortError' });
    else await pending;
    assert.equal(client.snapshot().stations.size, 0);
    assert.equal(!!client.nearbyStatus([179.8, 51])?.error, !cancel);
  }
});
