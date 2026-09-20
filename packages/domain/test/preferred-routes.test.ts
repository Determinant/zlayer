import assert from 'node:assert/strict';
import test from 'node:test';
import type { GeoPointFeature, PreferredRouteRecord } from '@zlayer/contracts';
import { preferredRouteAirports, preferredRoutesForAirports, preferredRouteText } from '../src/index.js';

const airport = (faaId: string, icaoId: string): GeoPointFeature => ({
  type: 'Feature', id: `airport:${faaId}`, geometry: { type: 'Point', coordinates: [-120, 35] },
  properties: { kind: 'landing-facility', faaId, icaoId },
});
const airports = [airport('SBA', 'KSBA'), airport('SMO', 'KSMO'), airport('ANC', 'PANC')];
const route: PreferredRouteRecord = { id: 'preferred-route:SBA:SMO:TEC:4', originId: 'SBA', destinationId: 'SMO',
  routeType: 'TEC', routeNumber: 4, route: 'KWANG CMA VNY V186 DARTS', segments: [] };

test('airport-pair lookup accepts FAA/ICAO codes and ignores all intermediate entries', () => {
  const pair = preferredRouteAirports(['KSBA', 'KSMO'], airports)!;
  assert.deepEqual(preferredRouteAirports(['sba', 'UNKNOWN', 'PANC', 'V186', 'smo'], airports), pair);
  assert.equal(preferredRouteAirports(['PANC', 'KSBA'], airports)?.origin.properties.faaId, 'ANC');
  for (const tokens of [[], ['SBA'], ['FIX', 'SBA', 'SMO'], ['SBA', 'SMO', 'FIX']]) {
    assert.equal(preferredRouteAirports(tokens, airports), undefined);
  }
  assert.equal(preferredRouteAirports(['SBA', 'SMO'], airports, { 0: 'navaid:SBA' }), undefined);
  assert.deepEqual(preferredRouteAirports(['SBA', 'SMO'], airports, { 0: airports[0]!.id! }), pair);
  assert.equal(preferredRouteAirports(['SBA', 'SMO'], [...airports, airport('SBA', 'OTHER')]), undefined);
});

test('recommendations preserve variants and only match the requested direction', () => {
  const second = { ...route, id: 'preferred-route:SBA:SMO:TEC:5', routeNumber: 5 };
  const high = { ...route, id: 'preferred-route:SBA:SMO:H:4', routeType: 'H' };
  const reverse = { ...route, originId: 'SMO', destinationId: 'SBA' };
  const pair = preferredRouteAirports(['KSBA', 'KSMO'], airports)!;
  assert.deepEqual(preferredRoutesForAirports([route, second, high, reverse], pair), [route, second, high]);
  assert.deepEqual(preferredRoutesForAirports([route], { origin: airports[2]!, destination: airports[1]! }), []);
});

test('imported recommendations use endpoint airports without duplicating them or inventing blank routes', () => {
  const pair = preferredRouteAirports(['KSBA', 'KSMO'], airports)!;
  assert.equal(preferredRouteText(route, pair), 'KSBA KWANG CMA VNY V186 DARTS KSMO');
  assert.equal(preferredRouteText({ ...route, route: 'SBA KWANG CMA KSMO' }, pair), 'KSBA KWANG CMA KSMO');
  assert.equal(preferredRouteText({ ...route, route: 'DCT' }, pair), 'KSBA KSMO');
  const withoutRoute = { ...route };
  delete withoutRoute.route;
  assert.equal(preferredRouteText(withoutRoute, pair), undefined);
});

test('published endpoint navaids are not deduplicated as airport aliases', () => {
  const pair = { origin: airport('ACK', 'KACK'), destination: airport('ALB', 'KALB') };
  const published = { ...route, route: 'ACK V146 ALB', segments: [
    { sequence: 5, value: 'ACK', type: 'NAVAID' },
    { sequence: 10, value: 'V146', type: 'AIRWAY' },
    { sequence: 15, value: 'ALB', type: 'NAVAID' },
  ] };
  assert.equal(preferredRouteText(published, pair), 'KACK ACK V146 ALB KALB');
  assert.equal(preferredRouteText({ ...published, route: 'ACK DCT ALB', segments: [
    { sequence: 5, value: 'ACK', type: 'NAVAID' },
    { sequence: 10, value: 'DCT', type: 'DIRECT' },
    { sequence: 15, value: 'ALB', type: 'NAVAID' },
  ] }, pair), 'KACK ACK ALB KALB');
  assert.equal(preferredRouteText({ ...published, route: 'ACK ALB', segments: [
    { sequence: 5, value: 'ACK', type: 'AIRPORT' },
    { sequence: 10, value: 'ALB', type: 'AIRPORT' },
  ] }, pair), 'KACK KALB');
});
