import assert from 'node:assert/strict';
import test from 'node:test';
import { Color, createExpression } from '@maplibre/maplibre-gl-style-spec';
import { VIEWPORT_ELEVATION_OFFSET, viewportPalette, viewportPixels } from '../src/layers/terrain/viewport';
import { clearanceColor } from '../src/layers/terrain/clearance';
import { TERRAIN_FILL_OPACITY, terrainColor } from '../src/layers/terrain/palette';

function palette(altitude: number | null, interval = 1000) {
  const compiled = createExpression(viewportPalette(altitude, interval), 'terrain',
    { type: 'color', 'property-type': 'color-ramp', transition: false, overridable: false });
  assert.equal(compiled.result, 'success');
  if (compiled.result !== 'success') throw new Error('Invalid viewport palette');
  return (elevation: number) => compiled.value.evaluate({ zoom: 9, elevation }) as Color;
}

test('viewport textures preserve narrow native peaks, negative elevations and unknown cells', () => {
  const values = new Float32Array([-125.75, 32800.25, NaN, 1450.125]);
  const { pixels, incomplete } = viewportPixels(values, 4, 2);
  assert.equal(incomplete, true);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    const height = values[Math.floor(y / 2) * 2 + Math.floor(x / 2)]!;
    const i = (y * 4 + x) * 4;
    const packed = pixels[i]! * 65536 + pixels[i + 1]! * 256 + pixels[i + 2]!;
    assert.equal(packed, Number.isFinite(height) ? Math.ceil(height) + VIEWPORT_ELEVATION_OFFSET : 0);
    assert.equal(pixels[i + 3], 255, 'numeric bytes never undergo alpha premultiplication');
  }
  assert.equal(viewportPixels(new Float32Array([0]), 1, 1).incomplete, false);
  assert.equal(viewportPixels(new Float32Array([Infinity]), 1, 1).incomplete, true);
});

test('viewport clearance follows native elevations at exact boundaries, independently of contour intervals', () => {
  for (const altitude of [0, 4500, 25000]) for (const interval of [500, 1000]) {
    const color = palette(altitude, interval);
    assert.equal(color(-VIEWPORT_ELEVATION_OFFSET).a, 0, 'missing data stays transparent at every altitude');
    for (const clearance of [-100, 0, 1, 499, 500, 999, 1000, 1999, 2000, 2500]) {
      const actual = color(altitude - clearance);
      const expected = Color.parse(clearanceColor(clearance))!;
      if (!expected.a) { assert.equal(actual.a, 0); continue; }
      assert.equal(actual.a, TERRAIN_FILL_OPACITY);
      for (const channel of ['r', 'g', 'b'] as const) {
        assert.ok(Math.abs(actual[channel] / actual.a - expected[channel]) < 1e-5);
      }
    }
  }
  const color = palette(4500);
  assert.notEqual(color(3100).toString(), color(3600).toString(), 'clearance is not rounded to the top of a 1,000 ft contour band');
});

test('viewport elevation shading retains the lowland cutoff and refines color between contours', () => {
  for (const interval of [500, 1000]) {
    const color = palette(null, interval);
    for (const height of [-VIEWPORT_ELEVATION_OFFSET, -100, 0, interval - 1]) assert.equal(color(height).a, 0);
    for (const height of [interval, 1430, 4500, 10000, 32800]) {
      assert.equal(color(height).toString(), Color.parse(`rgba(${terrainColor(height).join(',')},${TERRAIN_FILL_OPACITY})`)!.toString());
    }
  }
});
