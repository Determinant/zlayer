import assert from 'node:assert/strict';
import test from 'node:test';
import type { GeoPointFeature, PointGeometry } from '@zlayer/contracts';
import { nearbyVorStations } from '../src/nearby-navaids.js';
import { isMonVor } from '../src/mon-vors.js';

const station = (ident: string, coordinates: PointGeometry['coordinates'] = [0, 0],
  properties: GeoPointFeature['properties'] = {}): GeoPointFeature => ({
  type: 'Feature', id: ident, geometry: { type: 'Point', coordinates },
  properties: { kind: 'navaid', ident, type: 'VOR/DME', stationDeclinationDeg: 0, ...properties },
});

test('radials run FROM the station and subtract east-positive station declination', () => {
  for (const [point, bearing] of [[[0, 1], 0], [[1, 0], 90], [[0, -1], 180], [[-1, 0], 270]] as const) {
    for (const variation of [15, -15, 0]) {
      const result = nearbyVorStations([...point], [station('VOR', [0, 0], { stationDeclinationDeg: variation })])[0]!;
      assert.equal(result.trueBearing, bearing);
      assert.equal(result.radial, (bearing - variation + 360) % 360);
      assert.ok(Math.abs(result.distanceNm - 60.04) < 0.01);
    }
  }
});

test('returns nearby VOR facilities within 100 NM, excluding test and inactive transmitters', () => {
  const result = nearbyVorStations([0, 0], [
    station('far', [0, 2]), station('third', [0, 0.8], { type: 'VOR-DME' }),
    station('second', [0, 0.5], { type: 'VORTAC', status: 'OPERATIONAL RESTRICTED' }),
    station('nearest', [0, 0.2], { type: 'VOR' }), station('fourth', [0, 1]),
    ...['VOT', 'DME', 'NDB', 'TACAN', 'ILS/DME'].map(type => station(type, [0, 0.1], { type })),
    station('closed', [0, 0.01], { status: 'DECOMMISSIONED' }),
    station('unusable', [NaN, 0]),
  ]);
  assert.deepEqual(result.map(item => item.feature.properties.ident), ['nearest', 'second', 'third', 'fourth']);
});

test('canonical and compact VOR/DME spellings identify the same nearby station', () => {
  for (const type of ['VOR/DME', 'VORDME', 'VOR-DME', ' vordme ']) {
    const feature = station('ABC', [0, 0.5], { type });
    assert.equal(nearbyVorStations([0, 0], [feature])[0]?.feature, feature);
  }
  for (const type of ['NDBDME', 'NDB-DME', 'VOR--DME', 'VOT/DME', 'UNKNOWN']) {
    assert.deepEqual(nearbyVorStations([0, 0], [station('ABC', [0, 0.5], { type })]), []);
  }
});

test('useful distances precede fallbacks, with MON candidates first inside the 5–60 NM band', () => {
  const result = nearbyVorStations([0, 0], [
    station('near', [0, 0.2]), station('CMA', [0, 0.5], { state: 'CA' }),
    station('far', [0, 0.9]), station('GVO', [0, 0.02], { state: 'CA' }),
    station('RZS', [0, 1.3], { state: 'CA' }), station('outside', [0, 1.02]),
    station('seventh', [0, 1.5]), station('SAME'),
  ]);
  assert.deepEqual(result.map(item => item.feature.properties.ident), ['CMA', 'near', 'far', 'outside', 'GVO', 'RZS']);
  assert.deepEqual(result.map(item => item.mon), [true, false, false, false, true, true]);
});

test('MON identity comes from the dated FAA list and matches station state and country', () => {
  assert.equal(isMonVor(station('CMA', [0, 0], { state: 'CA', country: 'US' })), true);
  assert.equal(isMonVor(station(' cma ', [0, 0], { state: ' ca ' })), true);
  assert.equal(isMonVor(station('CMA', [0, 0], { state: 'NV' })), false);
  assert.equal(isMonVor(station('CMA', [0, 0], { state: 'CA', country: 'CA' })), false);
  assert.equal(isMonVor(station('CMA')), false);
  assert.equal(isMonVor(station('ZZZ', [0, 0], { state: 'CA' })), false);
});

test('missing or invalid variation leaves the magnetic radial unavailable without inventing zero variation', () => {
  for (const variation of [undefined, NaN, 181, null, '15']) {
    const feature = station('VOR');
    Object.assign(feature.properties, { stationDeclinationDeg: variation });
    const result = nearbyVorStations([1, 0], [feature])[0]!;
    assert.equal(result.radial, null);
    assert.equal(result.trueBearing, 90);
  }
});

test('co-located stations are excluded and dateline distances remain local', () => {
  assert.deepEqual(nearbyVorStations([10, 80], [station('SAME', [10, 80])]), []);
  const crossing = nearbyVorStations([-179.8, 0], [station('DATE', [179.8, 0])])[0]!;
  assert.ok(Math.abs(crossing.distanceNm - 24.016) < 0.01);
  assert.equal(crossing.radial, 90);
  assert.deepEqual(nearbyVorStations([0, 0], []), []);
});
