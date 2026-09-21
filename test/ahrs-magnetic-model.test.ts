import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { decimalYear, isMagneticModel, magneticBearing, magneticField } from '../src/core/geo/magnetic-model';

const document: unknown = JSON.parse(readFileSync(new URL('./fixtures/magnetic-model.json', import.meta.url), 'utf8'));
assert.ok(isMagneticModel(document));
const model = document;
const near = (actual: number, expected: number, tolerance: number) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

test('WMM2025 agrees with all NOAA reference vectors at both dates, heights and hemispheres', () => {
  const source = readFileSync(new URL('./fixtures/WMM2025_TEST_VALUES.txt', import.meta.url), 'utf8');
  const rows = source.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#'));
  assert.equal(rows.length, 12);
  for (const row of rows) {
    const [year, height, latitude, longitude, x, y, z, horizontal, , , declination] = row.trim().split(/\s+/).map(Number);
    const start = Date.UTC(Math.floor(year!), 0, 1), end = Date.UTC(Math.floor(year!) + 1, 0, 1);
    const time = start + (year! % 1) * (end - start);
    const field = magneticField(model, [longitude! > 180 ? longitude! - 360 : longitude!, latitude!], height! * 1000, time)!;
    assert.ok(field, row);
    near(field.north, x!, .1); near(field.east, y!, .1); near(field.down, z!, .1);
    near(field.horizontal, horizontal!, .1); near(field.declination, declination!, .006);
  }
});

test('model guard rejects incompatible conventions, missing/reordered/invalid terms and extended validity', () => {
  for (const change of [{ normalization: 'unnormalized' }, { altitudeReference: 'MSL' },
    { declinationConvention: 'west-positive' }, { coefficientUnits: 'uT' }, { maxDegree: 13 },
    { validUntil: '2035-01-01' }, { coefficients: model.coefficients.slice(1) },
    { coefficients: [...model.coefficients].reverse() },
    { coefficients: model.coefficients.map((row, i) => i ? row : [1, 0, NaN, 0, 0, 0]) }]) {
    assert.equal(isMagneticModel({ ...document as object, ...change }), false);
  }
});

test('east/west variation and wraparound use magnetic = true minus east declination', () => {
  assert.equal(magneticBearing(75, 13), 62);
  assert.equal(magneticBearing(5, 13), 352);
  assert.equal(magneticBearing(355, -12), 7);
  assert.equal(magneticBearing(360, 0), 0);
});

test('evaluation uses UTC leap years, actual model validity and valid geographic inputs', () => {
  assert.equal(decimalYear(Date.UTC(2028, 6, 2)), 2028.5);
  const now = Date.UTC(2026, 8, 18), position = [-122, 37] as const;
  for (const time of [NaN, Date.UTC(2024, 11, 31), Date.UTC(2030, 0, 1)]) {
    assert.equal(magneticField(model, position, null, time), null);
  }
  assert.ok(magneticField(model, position, 0, Date.UTC(2025, 0, 1)));
  assert.ok(magneticField(model, position, 0, Date.UTC(2029, 11, 31)));
  assert.equal(magneticField(model, [0, 91], 0, now), null);
  assert.equal(magneticField(model, [NaN, 0], 0, now), null);
  assert.equal(magneticField(model, position, Infinity, now), null);
  assert.equal(magneticField(model, position, -1001, now), null);
  assert.deepEqual(magneticField(model, position, null, now), magneticField(model, position, 0, now));
  assert.ok(magneticField(model, [0, 90], 0, now));
  assert.ok(magneticField(model, [0, -90], 0, now));
  assert.ok(magneticField(model, [140, 86], 0, now)!.horizontal < 2000, 'recognizes northern magnetic blackout');
});
