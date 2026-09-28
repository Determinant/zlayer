import assert from 'node:assert/strict';
import test from 'node:test';
import { runwayHeading, runwayWindComponents } from '../src/runway-wind.js';

test('computes head/tailwind and crosswind FROM each side for reciprocal runway ends', () => {
  assert.deepEqual(runwayWindComponents(90, { direction: 90, speedKt: 10 }),
    { kind: 'directional', headwindKt: 10, crosswindKt: 0 });
  assert.deepEqual(runwayWindComponents(270, { direction: 90, speedKt: 10 }),
    { kind: 'directional', headwindKt: -10, crosswindKt: 0 });
  assert.deepEqual(runwayWindComponents(90, { direction: 180, speedKt: 10 }),
    { kind: 'directional', headwindKt: 0, crosswindKt: 10 });
  assert.deepEqual(runwayWindComponents(90, { direction: 0, speedKt: 10 }),
    { kind: 'directional', headwindKt: 0, crosswindKt: -10 });
});

test('uses true headings across north and calculates gusts at the reported direction', () => {
  const result = runwayWindComponents(350, { direction: '020', speedKt: 10, gustKt: 20 });
  assert.equal(result.kind, 'directional');
  if (result.kind !== 'directional') return;
  assert.ok(Math.abs(result.headwindKt - Math.sqrt(75)) < 1e-10);
  assert.ok(Math.abs(result.crosswindKt - 5) < 1e-10);
  assert.ok(Math.abs(result.gust!.crosswindKt - 10) < 1e-10);
  assert.deepEqual(runwayWindComponents(360, { direction: 0, speedKt: 10 }),
    { kind: 'directional', headwindKt: 10, crosswindKt: 0 });
});

test('keeps calm, variable and unavailable winds distinct without inventing a runway heading', () => {
  assert.deepEqual(runwayWindComponents(undefined, { direction: null, speedKt: 0 }), { kind: 'calm' });
  assert.deepEqual(runwayWindComponents(90, { direction: 'VRB', speedKt: 4, gustKt: 8 }),
    { kind: 'variable', speedKt: 4, gustKt: 8 });
  assert.deepEqual(runwayWindComponents(undefined, { direction: 90, speedKt: 10 }),
    { kind: 'unavailable', reason: 'heading' });
  for (const direction of [undefined, null, '', 999, -1, NaN, 'missing']) {
    assert.deepEqual(runwayWindComponents(90, { direction, speedKt: 10 }),
      { kind: 'unavailable', reason: 'direction' });
  }
  for (const speedKt of [undefined, null, -1, NaN, Infinity]) {
    assert.deepEqual(runwayWindComponents(90, { direction: 90, speedKt }),
      { kind: 'unavailable', reason: 'speed' });
  }
  assert.deepEqual(runwayWindComponents(90, { direction: 90, speedKt: 10, gustKt: 5 }),
    { kind: 'directional', headwindKt: 10, crosswindKt: 0 });
});

test('matching magnetic bearings give the same components as matching true bearings', () => {
  const trueWind = runwayWindComponents(55, { direction: 350, speedKt: 12, gustKt: 20 });
  assert.equal(trueWind.kind, 'directional');
  if (trueWind.kind !== 'directional') return;
  for (const declination of [-15, 0, 11.3]) {
    const magnetic = (degrees: number) => (degrees - declination + 360) % 360;
    const wind = runwayWindComponents(magnetic(55), { direction: magnetic(350), speedKt: 12, gustKt: 20 });
    assert.equal(wind.kind, 'directional');
    if (wind.kind !== 'directional') continue;
    assert.ok(Math.abs(wind.headwindKt - trueWind.headwindKt) < 1e-10);
    assert.ok(Math.abs(wind.crosswindKt - trueWind.crosswindKt) < 1e-10);
    assert.ok(Math.abs(wind.gust!.headwindKt - trueWind.gust!.headwindKt) < 1e-10);
    assert.ok(Math.abs(wind.gust!.crosswindKt - trueWind.gust!.crosswindKt) < 1e-10);
  }
});


test('heading priority is published magnetic, published true, then runway-number estimate', () => {
  const end = { id: '04L', magneticHeadingDeg: 43.7, trueHeadingDeg: 55 };
  assert.deepEqual(runwayHeading(end), { degrees: 43.7, reference: 'magnetic', estimated: false });
  assert.deepEqual(runwayHeading(end, false), { degrees: 55, reference: 'true', estimated: false });
  assert.deepEqual(runwayHeading({ id: '04L', trueHeadingDeg: 55 }), { degrees: 55, reference: 'true', estimated: false });
  assert.deepEqual(runwayHeading({ id: '04L' }), { degrees: 40, reference: 'magnetic', estimated: true });
  assert.equal(runwayHeading({ id: '04L' }, false), undefined, 'estimates also require magnetic wind');
  assert.equal(runwayHeading({ id: '04L', magneticHeadingDeg: 43.7 }, false), undefined);
});

test('runway-number estimates handle north and published suffixes without guessing named or malformed ends', () => {
  for (const [id, degrees] of [['1', 10], ['01', 10], ['04L', 40], ['22R', 220], ['09C', 90], ['36', 360],
    ['08G', 80], ['18W', 180], ['09U', 90], ['16S', 160], ['032', 30]] as const) {
    assert.deepEqual(runwayHeading({ id }), { degrees, reference: 'magnetic', estimated: true }, id);
  }
  for (const id of ['H1', 'H04', 'N', 'NE', 'ALL', '', '0', '00', '37', '99', '3600', '004', '04/22', '04T', '04XYZ', 'RW04']) {
    assert.equal(runwayHeading({ id }), undefined, id);
  }
});
