import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createRulerLayer } from '../src/layers/ruler/layer';
import { formatBearing, initialBearing, measure, rulerPath } from '../src/layers/ruler/measurement';
import { gripPosition, suggestedEnd } from '../src/layers/ruler/handles';
import { isMagneticModel, magneticField } from '../src/core/geo/magnetic-model';

const model: unknown = JSON.parse(readFileSync(new URL('./fixtures/magnetic-model.json', import.meta.url), 'utf8'));
assert.ok(isMagneticModel(model));
const time = Date.UTC(2026, 8, 21);
const near = (actual: number, expected: number, tolerance = .001) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

test('ruler uses great-circle NM and the magnetic variation at its start', () => {
  const east = measure([0, 0], [1, 0], null, time);
  near(east.distance, 60.04046);
  assert.equal(east.bearing, 90);
  assert.equal(east.trueBearing, 90);
  assert.equal(east.magnetic, false);
  const a: [number, number] = [-122, 37], b: [number, number] = [-72, 42];
  const forward = measure(a, b, model, time), reverse = measure(b, a, model, time);
  near(forward.trueBearing!, initialBearing(a, b)!);
  near(reverse.trueBearing!, initialBearing(b, a)!);
  near(forward.bearing!, (initialBearing(a, b)! - magneticField(model, a, 0, time)!.declination + 360) % 360);
  near(reverse.bearing!, (initialBearing(b, a)! - magneticField(model, b, 0, time)!.declination + 360) % 360);
  assert.ok(Math.abs((forward.bearing! + 180) % 360 - reverse.bearing!) > 10);
  near(forward.distance, reverse.distance);
});

test('undefined bearings and invalid magnetic references are labeled honestly', () => {
  assert.equal(measure([0, 0], [0, 0], model, time).bearing, null);
  assert.equal(measure([0, 0], [180, 0], model, time).bearing, null);
  assert.equal(measure([0, 90], [0, 80], model, time).bearing, null);
  assert.equal(measure([140, 86], [141, 85], model, time).magnetic, false);
  assert.equal(measure([0, 0], [1, 1], model, Date.UTC(2030, 0, 1)).magnetic, false);
  assert.equal(formatBearing(359.7, true), '000°M');
  assert.equal(formatBearing(7, false), '007°T');
  assert.equal(formatBearing(null, true), '—');
});

test('ruler rendering follows the short great circle across the dateline', () => {
  const path = rulerPath([179, 40], [-179, 40]);
  assert.deepEqual(path.at(-1), [181, 40]);
  assert.ok(path.every((point, i) => !i || Math.abs(point[0] - path[i - 1]![0]) < 3));
  const long = rulerPath([-122, 37], [2, 49]);
  assert.ok(long.some(point => point[1] > 60), 'long-distance arc curves poleward');
  assert.deepEqual(rulerPath([0, 0], [0, 0]), []);
});

test('desktop placement, touch preview, cancellation and fresh sessions stay distinct', () => {
  const ruler = createRulerLayer();
  ruler.place([1, 2]);
  assert.equal(ruler.getSnapshot().start, null);
  ruler.open(); ruler.place([1, 2]);
  assert.equal(ruler.getSnapshot().end, null);
  ruler.place([3, 4]); ruler.place([9, 9]);
  assert.deepEqual(ruler.getSnapshot().end, [3, 4]);
  ruler.reverse();
  assert.deepEqual(ruler.getSnapshot().start, [3, 4]);
  ruler.restart(); ruler.place([181, 2], [181, 3]);
  const before = ruler.getSnapshot();
  assert.deepEqual(before.start, [-179, 2]);
  assert.equal(before.provisional, true);
  ruler.move('end', [180, 4]); ruler.restore(before);
  assert.deepEqual(ruler.getSnapshot(), before);
  ruler.move('end', [180, 4], true);
  assert.equal(ruler.getSnapshot().provisional, false);
  ruler.close(); ruler.restore(before);
  assert.equal(ruler.getSnapshot().active, false, 'an old canceled drag cannot reopen the tool');
});

test('initial B and separated grips remain reachable near edges', () => {
  assert.deepEqual(suggestedEnd({ x: 300, y: 400 }, 744, 900), { x: 300, y: 280 });
  const nearTop = suggestedEnd({ x: 300, y: 10 }, 744, 900);
  assert.ok(nearTop.y >= 32 && Math.hypot(nearTop.x - 300, nearTop.y - 10) >= 120);
  for (const anchor of [{ x: 4, y: 4 }, { x: 740, y: 4 }, { x: 4, y: 896 }, { x: 740, y: 896 }]) {
    const grip = gripPosition(anchor, null, null, 744, 900, [], true);
    assert.ok(grip.x >= 24 && grip.x <= 720 && grip.y >= 24 && grip.y <= 876);
    assert.ok(Math.hypot(grip.x - anchor.x, grip.y - anchor.y) > 60);
  }
  const a = { x: 300, y: 300 }, b = { x: 305, y: 300 };
  const ga = gripPosition(a, b, null, 744, 900, [], true);
  const gb = gripPosition(b, a, ga, 744, 900, [], true);
  assert.ok(Math.hypot(ga.x - gb.x, ga.y - gb.y) >= 54);
});
