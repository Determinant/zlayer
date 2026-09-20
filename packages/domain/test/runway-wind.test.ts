import assert from 'node:assert/strict';
import test from 'node:test';
import { runwayWindComponents } from '../src/runway-wind.js';

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
