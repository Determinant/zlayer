import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_PDF_CANVAS_PIXELS, pdfCanvasSize } from '../src/layers/plates/render-scale';

test('PDF backing resolution follows device density and pinch magnification without a 2x ceiling', () => {
  assert.deepEqual(pdfCanvasSize(320, 480, 3), { width: 960, height: 1440 });
  assert.deepEqual(pdfCanvasSize(320, 480, 3 * 2), { width: 1920, height: 2880 });
});

test('large and unusually shaped PDF pages stay within canvas memory and dimension limits', () => {
  for (const [width, height, ratio] of [[744, 1133, 12], [3840, 2160, 4], [50, 30000, 8], [30000, 50, 8]]) {
    const size = pdfCanvasSize(width!, height!, ratio!);
    assert.ok(size.width * size.height <= MAX_PDF_CANVAS_PIXELS);
    assert.ok(size.width > 0 && size.width <= 8192);
    assert.ok(size.height > 0 && size.height <= 8192);
  }
});
