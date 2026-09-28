import assert from 'node:assert/strict';
import test from 'node:test';
import { createViewReporter } from '../src/workspace/map/view-reporter';
import type { MapView } from '../src/workspace/map/style';

test('continuous GPS camera movement has bounded writes and saves the latest view', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let view: MapView = { center: [0, 0], zoom: 9, bearing: 0, pitch: 0 };
  const saved: MapView[] = [];
  const reporter = createViewReporter(() => view, next => saved.push(next));
  reporter.flush();
  for (let i = 1; i <= 100; i++) {
    view = { ...view, center: [i, 0] };
    reporter.report(true); t.mock.timers.tick(100);
  }
  assert.equal(saved.length, 6);
  assert.deepEqual(saved.at(-1), view);
  t.mock.timers.tick(20_000);
  assert.equal(saved.length, 6, 'no polling while idle');
});

test('user actions and lifecycle flush sample the live camera and cancel pending GPS writes', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let view: MapView = { center: [0, 0], zoom: 9, bearing: 0, pitch: 0 };
  const saved: MapView[] = [];
  const reporter = createViewReporter(() => view, next => saved.push(next));
  reporter.report(true);
  view = { ...view, zoom: 10 }; reporter.report();
  assert.equal(saved.length, 1);
  t.mock.timers.tick(2000); assert.equal(saved.length, 1);
  reporter.report(true);
  view = { ...view, center: [1, 1] }; reporter.flush();
  assert.deepEqual(saved.at(-1), view, 'capture even an unfinished animation on background/teardown');
  t.mock.timers.tick(20_000); assert.equal(saved.length, 2);
});
