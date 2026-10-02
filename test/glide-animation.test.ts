import assert from 'node:assert/strict';
import test from 'node:test';
import clipping from 'polygon-clipping';
import { project, nmPerWorldUnit, type Point } from '../src/core/geo/route-corridor';
import { mergeFootprints } from '../src/layers/glide/geometry';
import { createRangeAnimation, rangeTransition } from '../src/layers/glide/range-animation';
import type { GlideRange } from '../src/layers/glide/types';
import { destination } from '../src/layers/ownship/position';

function circle(origin: Point, key: string, radii = Array<number>(32).fill(2)): GlideRange {
  const center = project(origin), scale = nmPerWorldUnit(center[1]);
  const ring: Point[] = radii.map((radius, i) => [center[0] + Math.cos(i / radii.length * 2 * Math.PI) * radius / scale,
    center[1] + Math.sin(i / radii.length * 2 * Math.PI) * radius / scale]);
  ring.push(ring[0]!);
  const area = mergeFootprints([[ring]]);
  return { key, area, incomplete: false, line: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {},
    geometry: { type: 'MultiLineString', coordinates: area.features.flatMap(feature => feature.geometry.coordinates.flat()) } }] } };
}
const east = (range: GlideRange) => Math.max(...range.area.features.flatMap(feature => feature.geometry.coordinates.flat(2).map(point => point[0]!)));
function assertContained(frame: GlideRange, target: GlideRange) {
  const projected = (range: GlideRange) => range.area.features[0]!.geometry.coordinates
    .map(polygon => polygon.map(ring => ring.map(point => project(point as Point))));
  const outside = clipping.difference(projected(frame), projected(target));
  const area = outside.reduce((sum, polygon) => sum + polygon.reduce((total, ring) => {
    const origin = ring[0]!;
    return total + Math.abs(ring.slice(1).reduce((value, point, i) => {
      const previous = ring[i]!;
      return value + (previous[0] - origin[0]) * (point[1] - origin[1]) - (previous[1] - origin[1]) * (point[0] - origin[0]);
    }, 0)) / 2;
  }, 0), 0);
  assert.ok(area < 1e-18, `outside area ${area} exceeds projection round-trip tolerance`);
}

test('nearby ranges move through intermediate outlines and stay inside the new terrain footprint', () => {
  const origin: Point = [-122, 37], next: Point = [-121.9994, 37];
  const from = circle(origin, 'old'), to = circle(next, 'new');
  const transition = rangeTransition({ range: from, origin }, { range: to, origin: next })!;
  assert.ok(transition);
  let previous = east(from);
  for (const t of [.2, .4, .6, .8, 1]) {
    const frame = transition(t), edge = east(frame);
    assert.ok(edge > previous && edge <= east(to));
    assertContained(frame, to);
    assert.deepEqual(frame.line.features[0]!.geometry.coordinates, frame.area.features[0]!.geometry.coordinates.flat());
    previous = edge;
  }
  assert.equal(transition(1), to, 'finish with the exact calculated result');
});

test('new terrain notches cut back immediately throughout a moving transition', () => {
  const origin: Point = [0, 0], next: Point = [.0005, .0002];
  const from = circle(origin, 'old');
  const radii = Array.from({ length: 40 }, (_, i) => i > 12 && i < 20 ? .3 : 2.05);
  const to = circle(next, 'ridge', radii);
  const transition = rangeTransition({ range: from, origin }, { range: to, origin: next })!;
  assert.ok(transition);
  for (const t of [0, .1, .5, .9]) {
    const frame = transition(t);
    assertContained(frame, to);
    assert.ok(frame.line.features.length, 'the moving outline remains visible');
  }
});

test('incomplete, open, empty and antimeridian-split ranges bypass interpolation', () => {
  const origin: Point = [0, 0], range = circle(origin, 'full');
  for (const other of [
    { ...range, incomplete: true },
    { ...range, area: { type: 'FeatureCollection' as const, features: [] } },
    { ...range, line: { type: 'FeatureCollection' as const, features: [] } },
    circle([179.999, 0], 'dateline'),
  ]) {
    assert.equal(rangeTransition({ range, origin }, { range: other, origin }), undefined);
  }
});

function animationHarness(t: test.TestContext) {
  let time = 0, id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  for (const [name, value] of Object.entries({
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; },
    cancelAnimationFrame: (key: number) => { frames.delete(key); },
  })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => { if (original) Object.defineProperty(globalThis, name, original); else Reflect.deleteProperty(globalThis, name); });
  }
  t.mock.method(performance, 'now', () => time);
  return { frames, async advance(ms: number) {
    time += ms;
    const pending = [...frames.values()]; frames.clear();
    for (const callback of pending) callback(time);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  } };
}

test('animation bounds uploads, ends at the exact result and stays idle afterward', async t => {
  const clock = animationHarness(t), uploads: GlideRange[] = [];
  const animation = createRangeAnimation(async range => { uploads.push(range); });
  t.after(animation.reset);
  const from = circle([0, 0], 'old'), to = circle([.0005, 0], 'new');
  animation.set(from, [0, 0], true); await clock.advance(1000);
  assert.equal(clock.frames.size, 0);
  animation.set(to, [.0005, 0], true);
  for (let i = 0; i < 60; i++) await clock.advance(16);
  assert.ok(uploads.length > 5 && uploads.length <= 21, 'smooth but capped at 30 source updates per second');
  assert.equal(uploads.at(-1), to);
  assert.equal(clock.frames.size, 0, 'no idle frame loop');
  animation.set(from, [0, 0], false); await clock.advance(16);
  assert.equal(uploads.at(-1), from, 'reduced motion bypasses interpolation');
  assert.equal(clock.frames.size, 0);
});

test('slow source uploads coalesce new targets and clearing cannot be revived by a pending frame', async t => {
  const clock = animationHarness(t), uploads: GlideRange[] = [];
  let release!: () => void;
  const animation = createRangeAnimation(range => { uploads.push(range); return new Promise<void>(resolve => { release = resolve; }); });
  t.after(animation.reset);
  const from = circle([0, 0], 'old'), to = circle([.0005, 0], 'new');
  animation.set(from, [0, 0], true);
  animation.set(to, [.0005, 0], true);
  await clock.advance(1000);
  assert.equal(uploads.length, 1, 'only one upload pair can be in flight');
  release(); await clock.advance(16); await clock.advance(16);
  assert.equal(uploads.length, 2);
  assert.equal(uploads[1], to, 'catch up to the latest target after backpressure');
  animation.set(from, [0, 0], true);
  animation.reset(); release(); await clock.advance(1000); await clock.advance(1000);
  assert.equal(uploads.length, 2);
  assert.equal(clock.frames.size, 0, 'GPS loss/unmount cannot leave animation work alive');
});

test('a minute of overlapping transitions keeps geometry bounded without periodic snaps', async t => {
  const clock = animationHarness(t);
  let origin: Point = [-122, 37], target = circle(origin, 'initial'), maxVertices = 0, writes = 0;
  let displayed = target;
  const animation = createRangeAnimation(async range => {
    displayed = range; writes++;
    const vertices = range.area.features.flatMap(feature => feature.geometry.coordinates.flat(2)).length;
    maxVertices = Math.max(maxVertices, vertices);
  });
  t.after(animation.reset);
  animation.set(target, origin, true); await clock.advance(1000);
  for (let i = 1; i <= 150; i++) {
    origin = destination(origin, 90, 30);
    target = circle(origin, String(i));
    animation.set(target, origin, true);
    for (let frame = 0; frame < 24; frame++) await clock.advance(1000 / 60);
    assert.notEqual(displayed, target, 'retargeting remains interpolated, including after the old 1024-vertex limit');
    assert.ok(east(displayed) < east(target));
    assertContained(displayed, target);
  }
  assert.ok(maxVertices <= 200, `flat footprints should stay compact, got ${maxVertices}`);
  assert.ok(writes <= 1802, 'source work remains capped during repeated retargeting');
  await clock.advance(600);
  assert.equal(displayed, target, 'the last target finishes exactly');
  assert.equal(clock.frames.size, 0);
});
