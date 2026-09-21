import assert from 'node:assert/strict';
import test from 'node:test';
import { pdfCanvasSize } from '../src/layers/plates/render-scale';

test('PDF backing resolution follows device density and pinch magnification without a 2x ceiling', () => {
  assert.deepEqual(pdfCanvasSize(320, 480, 3), { width: 960, height: 1440 });
  assert.deepEqual(pdfCanvasSize(320, 480, 3 * 2), { width: 1920, height: 2880 });
});

test('large and unusually shaped PDF pages retain resolution and proportions within canvas limits', () => {
  for (const [width, height, ratio, expectedWidth, expectedHeight] of [
    // The 32 MiB pixel budget limits these pages.
    [744, 1133, 12, 2347, 3574], [3840, 2160, 4, 3861, 2172],
    // The 8192-pixel side limit constrains unusually narrow or wide pages.
    [50, 30000, 8, 13, 8192], [30000, 50, 8, 8192, 13],
  ] as const) {
    assert.deepEqual(pdfCanvasSize(width, height, ratio), { width: expectedWidth, height: expectedHeight },
      `${width}×${height} at ${ratio}× density`);
  }
});
