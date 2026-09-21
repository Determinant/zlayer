import assert from 'node:assert/strict';
import test from 'node:test';
import { Color, createExpression } from '@maplibre/maplibre-gl-style-spec';
import type { Map as MapLibreMap, ExpressionSpecification } from 'maplibre-gl';
import { clearanceColor, clearanceText, displayElevation, packedTerrainValue, CLEARANCE_COLORS } from '../src/layers/terrain/clearance';
import { terrainFillPalette, syncTerrainAltitude } from '../src/layers/terrain/renderer';
import { TERRAIN_FILL_OPACITY, terrainColor } from '../src/layers/terrain/palette';
import { paintTerrain } from '../src/layers/terrain/contours';
import type { Segment } from '../src/layers/terrain/geometry';

function expression(value: ExpressionSpecification, color = false) {
  const compiled = createExpression(value, 'terrain', color
    ? { type: 'color', 'property-type': 'color-ramp', transition: false, overridable: false } : undefined);
  assert.equal(compiled.result, 'success');
  if (compiled.result !== 'success') throw new Error('Invalid terrain expression');
  return compiled.value;
}

test('clearance boundaries use selected altitude minus terrain, including zero and negative differences', () => {
  for (const [difference, color] of [[-100, 'above'], [0, 'above'], [100, 'close'], [499, 'close'],
    [500, 'near'], [999, 'near'], [1000, 'below'], [1999, 'below'], [2000, 'far']] as const) {
    assert.equal(clearanceColor(difference), CLEARANCE_COLORS[color]);
  }
  const high = displayElevation(4317, true);
  assert.equal(high, 4400);
  assert.equal(clearanceText(4500, high), '+100 ft');
  assert.equal(clearanceText(4000, high), '−400 ft');
  assert.equal(clearanceText(4400, high), '+0 ft');
});

test('one encoded tile can switch from elevation to conservative clearance colors without rebuilding', () => {
  const packed = packedTerrainValue(1430, 1000, 1); // Whole 1,000–2,000 ft band compares against its top.
  const evaluate = (altitude: number | null, index = packed) => expression(terrainFillPalette(altitude, 1000), true)
    .evaluate({ zoom: 9, elevation: index }) as Color;
  assert.equal(evaluate(null).toString(), Color.parse(`rgba(${terrainColor(1000).join(',')},${TERRAIN_FILL_OPACITY})`)!.toString());
  for (const [altitude, hex] of [[1900, CLEARANCE_COLORS.above], [2200, CLEARANCE_COLORS.close],
    [2500, CLEARANCE_COLORS.near], [3000, CLEARANCE_COLORS.below], [3999, CLEARANCE_COLORS.below]] as const) {
    const color = evaluate(altitude);
    assert.equal(color.a, TERRAIN_FILL_OPACITY);
    const expected = Color.parse(hex)!;
    for (const channel of ['r', 'g', 'b'] as const) assert.ok(Math.abs(color[channel] / color.a - expected[channel]) < 1e-5);
  }
  for (const altitude of [4000, 4500, 25000]) {
    assert.equal(evaluate(altitude).a, 0, '2,000 ft or more clearance leaves the whole band unshaded');
    assert.equal(evaluate(altitude, packedTerrainValue(1430, 1000, 0.5)).a, 0, 'outer corridor stays unshaded too');
  }
  const detail = expression(terrainFillPalette(3500, 500), true)
    .evaluate({ zoom: 11, elevation: packedTerrainValue(1430, 500, 1) }) as Color;
  assert.equal(detail.a, 0, 'the same clearance cutoff applies at the 500 ft detail interval');
  assert.equal(evaluate(null, packedTerrainValue(200, 1000, 1)).a, 0, 'absolute mode retains the unshaded lowland band');
  assert.ok(evaluate(0, packedTerrainValue(200, 1000, 1)).a > 0, 'clearance mode must include low terrain');
  assert.equal(evaluate(0, 0).a, 0, 'nodata/outside corridor must never get a clearance color');
  const faded = evaluate(1900, packedTerrainValue(1430, 1000, 0.5));
  assert.ok(Math.abs(faded.a / TERRAIN_FILL_OPACITY - 0.5) < 0.005);
});

test('packed pixels preserve band/opacity values and missing elevations at the worker boundary', () => {
  const size = 16, tile = { z: 12, x: 660, y: 1595 };
  const segment: Segment = [[660 / 4096, 1595 / 4096], [661 / 4096, 1596 / 4096]];
  const heights = new Float32Array(size * size).fill(1430);
  heights[0] = NaN; heights[1] = 200;
  const { pixels } = paintTerrain(heights, tile, [segment], 1000, size);
  const unpack = (i: number) => pixels[i * 4]! * 256 + pixels[i * 4 + 1]!;
  assert.equal(unpack(0), 0);
  assert.equal(unpack(1), packedTerrainValue(200, 1000, 1));
  assert.equal(unpack(2), packedTerrainValue(1430, 1000, 1));
  assert.equal(pixels[11], 255, 'packed bytes must not be premultiplied by corridor alpha');
});

test('rendered clearance text sits above the existing MSL label and mode switching restores it', () => {
  let field: ExpressionSpecification = ['get', 'label'];
  const map = { getLayer: () => ({}), setPaintProperty() {},
    setLayoutProperty(_id: string, _name: string, value: ExpressionSpecification) { field = value; },
  } as unknown as MapLibreMap;
  const feature = { type: 'Point' as const, properties: { displayElevation: 4400, label: '^ ~4,400 ft' } };
  for (const altitude of [4500, 4000, 4400]) {
    syncTerrainAltitude(map, altitude, 1000);
    const formatted = expression(field).evaluate({ zoom: 9 }, feature);
    assert.equal(String(formatted), `${clearanceText(altitude, 4400)}\n^ ~4,400 ft`);
  }
  syncTerrainAltitude(map, null, 1000);
  assert.equal(expression(field).evaluate({ zoom: 9 }, feature), '^ ~4,400 ft');
});
