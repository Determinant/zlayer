import assert from 'node:assert/strict';
import test from 'node:test';
import Point from '@mapbox/point-geometry';
import { TwoFingersTouchRotateHandler, TwoFingersTouchZoomHandler } from 'maplibre-gl';
import { configureTouchRotation } from '../src/core/map/touch-rotation';

const event = { preventDefault() {} } as TouchEvent;
const touches = [{ identifier: 1 }, { identifier: 2 }] as Touch[];

function points(degrees: number, diameter = 400): [Point, Point] {
  const radians = degrees * Math.PI / 180;
  const offset = new Point(Math.cos(radians), Math.sin(radians)).mult(diameter / 2);
  return [offset, offset.mult(-1)];
}

function setup(angle = 0, diameter = 400) {
  const rotate = new TwoFingersTouchRotateHandler();
  const zoom = new TwoFingersTouchZoomHandler();
  configureTouchRotation({ _touchRotate: rotate });
  rotate.enable();
  zoom.enable();
  const start = (degrees = angle, spacing = diameter) => {
    rotate.touchstart(event, points(degrees, spacing), touches);
    zoom.touchstart(event, points(degrees, spacing), touches);
  };
  start();
  return { rotate, start, move(degrees: number, spacing = diameter) {
    const position = points(degrees, spacing);
    return { rotation: rotate.touchmove(event, position, touches),
      zoom: zoom.touchmove(event, position, touches) };
  } };
}

function closeTo(actual: number | undefined, expected: number) {
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-8,
    `expected ${expected}, got ${actual}`);
}

for (const diameter of [240, 600]) {
  test(`pinching at ${diameter}px spacing zooms without rotating through small twists`, () => {
    const { move, rotate } = setup(0, diameter);
    for (const angle of [8, -8, 16, -16, 19, 0]) {
      const result = move(angle, diameter * 1.3);
      assert.equal(result.rotation, undefined);
      assert.equal(rotate.isActive(), false);
    }
    const result = move(12, diameter * 1.8);
    closeTo(result.zoom?.zoomDelta, Math.log2(1.8 / 1.3));
    assert.equal(result.rotation, undefined);
  });
}

for (const direction of [-1, 1]) {
  test(`deliberate rotation (${direction}) activates without a jump and stays responsive`, () => {
    const { move, rotate } = setup();
    assert.equal(move(direction * 19).rotation, undefined);
    assert.equal(move(direction * 24).rotation, undefined, 'discard the activation movement');
    assert.equal(rotate.isActive(), true);
    closeTo(move(direction * 25).rotation?.bearingDelta, -direction);
    closeTo(move(direction * 18).rotation?.bearingDelta, direction * 7);
    closeTo(move(direction * 17).rotation?.bearingDelta, direction);
  });
}

test('a fast first twist does not apply all of the ignored angle at once', () => {
  const { move, rotate } = setup();
  assert.equal(move(50).rotation, undefined);
  assert.equal(rotate.isActive(), true);
  closeTo(move(51).rotation?.bearingDelta, -1);
});

test('the native close-finger guard survives pinching in and back out', () => {
  const { move, rotate } = setup();
  move(0, 60);
  assert.equal(move(30, 400).rotation, undefined);
  assert.equal(rotate.isActive(), false, '20 degrees must not weaken the native guard');
  move(60, 400);
  assert.equal(rotate.isActive(), true);
  closeTo(move(61, 400).rotation?.bearingDelta, -1);
});

test('crossing the angle wrap does not look like a deliberate rotation', () => {
  const { move, rotate } = setup(175);
  assert.equal(move(-175).rotation, undefined);
  assert.equal(rotate.isActive(), false);
  move(-160);
  assert.equal(rotate.isActive(), true);
  closeTo(move(-159).rotation?.bearingDelta, -1);
});

test('touch identifiers keep a reordered touch list from reversing the angle', () => {
  const { rotate } = setup();
  assert.equal(rotate.touchmove(event, points(10).reverse(), [...touches].reverse()), undefined);
  assert.equal(rotate.isActive(), false);
});

for (const finish of ['end', 'cancel', 'disable'] as const) {
  test(`${finish} requires a fresh deliberate twist on the next gesture`, t => {
    const original = globalThis.window;
    globalThis.window = Object.assign(new EventTarget(), {
      setTimeout(callback: () => void) { callback(); return 0; },
    }) as unknown as Window & typeof globalThis;
    t.after(() => { globalThis.window = original; });
    const { move, rotate, start } = setup();
    move(25);
    assert.equal(rotate.isActive(), true);
    if (finish === 'end') rotate.touchend(event, [points(25)[0]], [touches[0]!]);
    else if (finish === 'cancel') rotate.touchcancel();
    else { rotate.disable(); rotate.enable(); }
    assert.equal(rotate.isActive(), false);
    start(25);
    assert.equal(move(40).rotation, undefined);
    assert.equal(rotate.isActive(), false);
    move(50);
    closeTo(move(51).rotation?.bearingDelta, -1);
  });
}
