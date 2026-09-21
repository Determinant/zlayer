import assert from 'node:assert/strict';
import test from 'node:test';
import type { TafReport } from '@zlayer/contracts';
import { hasCurrentReport, nearbyStations, stationChoices } from '../src/layers/metar-taf/nearby-stations';

const now = Date.parse('2026-09-17T18:00:00Z');
const report = (icaoId: string, lon: number, lat: number, extra: Partial<TafReport> = {}): TafReport => ({
  icaoId, lon, lat, issueTime: '2026-09-17T17:20:00Z', validTimeFrom: now / 1000,
  validTimeTo: now / 1000 + 86400, rawTAF: `TAF ${icaoId} TEST`, fcsts: [], ...extra,
});

test('shared station helpers recognize TAFs with extra upstream metadata', () => {
  const forecast = { ...report('KLAX', -118.40, 33.94), properties: { source: 'AWC' }, type: 'TAF' };
  assert.equal(hasCurrentReport(forecast, now), true);
  assert.equal(nearbyStations([-118.45, 34.02], [forecast], now)[0]?.stationId, 'KLAX');
  assert.equal(stationChoices(forecast, [], now)[0]?.report, forecast);
});

test('nearby TAFs prefer current forecasts, then distance, and retain expired reports as labeled fallbacks', () => {
  const stations = nearbyStations([-118.45, 34.02], [
    report('KBUR', -118.36, 34.20), report('KLAX', -118.40, 33.94),
    report('KOLD', -118.45, 34.021, { validTimeTo: now / 1000 }),
    report('KCNL', -118.45, 34.02, { rawTAF: 'TAF KCNL CNL' }),
    report('KNIL', -118.45, 34.02, { rawTAF: 'TAF KNIL NIL' }),
    report('KSBA', -119.84, 34.43),
    report('KUNK', -118.45, 34.02, { lat: null }),
  ], now);
  assert.deepEqual(stations.map(station => station.stationId), ['KLAX', 'KBUR', 'KOLD']);
  assert.equal(stations[0]?.direction, 'SE');
  assert.ok(stations[0]!.distanceNm > 5 && stations[0]!.distanceNm < 6);
  assert.equal(stations[1]?.direction, 'N');
  assert.equal(hasCurrentReport(stations[2]?.report, now), false);
});

test('nearby TAF discovery finds stations across the dateline', () => {
  const stations = nearbyStations([179.8, 51], [report('PADK', -179.9, 51)], now);
  assert.deepEqual(stations.map(station => station.stationId), ['PADK']);
});

test('station choices retain expired local TAFs without requiring coordinates and exclude cancelled or NIL forecasts', () => {
  const point: [number, number] = [-118.45, 34.02];
  const own = report('KSMO', ...point, { validTimeTo: now / 1000, lat: null, lon: null });
  const nearby = nearbyStations(point, [report('KLAX', -118.40, 33.94),
    report('KOLD', -118.36, 34.20, { validTimeTo: now / 1000 - 3600 })], now);
  const choices = stationChoices(own, nearby, now);
  assert.deepEqual(choices.map(station => station.stationId), ['KLAX', 'KSMO', 'KOLD']);
  assert.equal(choices[1]?.distanceNm, 0);
  assert.deepEqual(stationChoices(own, nearby, now + 86400_000).map(station => station.stationId),
    ['KSMO', 'KLAX', 'KOLD']);
  assert.equal(stationChoices({ ...own, validTimeTo: now / 1000 + 3600 }, nearby, now)[0]?.stationId, 'KSMO');
  assert.deepEqual(stationChoices(undefined, nearby, now), nearby);
  for (const rawTAF of ['TAF KSMO CNL', 'TAF KSMO NIL']) {
    assert.deepEqual(stationChoices({ ...own, rawTAF }, nearby, now), nearby);
  }
});
