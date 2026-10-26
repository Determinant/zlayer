import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createConverter } from '../tools/info-server/converter';
import { forecastConversionFixture } from './fixtures/forecast-conversion';
import { readModelTerrain } from '../src/layers/weather-awc/grids/model-terrain';
import { parseGribIndex, modelPath, OUTPUT_GRID } from '../src/layers/weather-awc/grids/native-source';
import { nativeForecastFiles } from './fixtures/awc-native.mjs';
import { unpackGrid, readBand } from '../src/layers/weather-awc/grids/packed';
import { GRID_BELOW_GROUND, GRID_MISSING, GRID_OUTSIDE } from '@zlayer/contracts';

const hash = (bytes: ArrayBuffer) => createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
test('reused converter preserves every packed NOAA wind/temperature and icing sample', () => {
  const converter = createConverter();
  for (const product of ['winds', 'icing', 'winds'] as const) {
    const fixture = forecastConversionFixture(product);
    converter.reset(); converter.init(fixture.manifest); converter.terrain(fixture.terrain);
    for (const input of fixture.inputs) {
      assert.equal(hash(input.raw), input.sourceSha256);
      converter.field(input.field, input.raw, input.identity);
    }
    assert.equal(hash(converter.finish().buffer), fixture.packedSha256);
  }
});

test('reusing wind geometry survives target, source and orientation changes and retains terrain masks', () => {
  const files = nativeForecastFiles(), runTime = Date.UTC(2026, 8, 22, 20);
  const grid = { ...OUTPUT_GRID, width: 17, height: 13 };
  const raw = (product: 'clouds' | 'winds', parameter: string, surface: string) => {
    const path = '/weather/noaa/' + modelPath(product, runTime, 0);
    const row = parseGribIndex(files.get(path + '.idx')!.toString(), runTime).find(row => row.parameter === parameter && row.surface === surface)!;
    return Uint8Array.from(files.get(path)!.subarray(row.start, row.end === undefined ? undefined : row.end + 1)).buffer;
  };
  const height = raw('clouds', 'HGT', 'surface');
  const fields = [raw('winds', 'HGT', '700 mb'), raw('winds', 'UGRD', '700 mb'), raw('winds', 'VGRD', '700 mb'), raw('winds', 'TMP', '700 mb')];
  const geometry = (raw: ArrayBuffer, meridian: number, relative = true) => {
    const result = raw.slice(0), view = new DataView(result);
    for (let at = 16; at < result.byteLength - 4; at += view.getUint32(at)) if (view.getUint8(at + 4) === 3) {
      view.setUint32(at + 51, meridian * 1e6);
      view.setUint8(at + 46, relative ? 8 : 0);
    }
    return result;
  };
  const reused = createConverter();
  for (const [relative, meridian, target] of [
    [true, 262.5, grid], [false, 262.5, grid], [true, 262.5, grid],
    [true, 262.5, { ...grid, width: 19 }],
    [true, 262.5, { ...grid, bounds: [-115, 25, -70, 49] }],
    [true, 265, grid], [true, 262.5, grid],
  ] as const) {
    const manifest = { product: 'winds' as const, fields: ['windHeight', 'windEast', 'windNorth', 'temperature'] as const,
      grid: { ...target, bounds: [...target.bounds] as [number, number, number, number] } };
    // A different converter prepares this input, just as a worker can retain
    // terrain from an earlier job without recomputing its current mapping.
    const terrain = createConverter().prepareTerrain(geometry(height, meridian),
      { runTime, lead: 0, category: 3, parameter: 5, surface: 1 }, manifest.grid);
    assert.deepEqual(readModelTerrain(terrain.buffer, manifest.grid).values, terrain.values);
    const count = terrain.values.length;
    const missing = terrain.values.findIndex(Number.isFinite), below = missing + 1;
    assert.ok(missing >= 0 && Number.isFinite(terrain.values[below]));
    terrain.values[missing] = NaN; terrain.values[below] = 5000;
    const convert = (converter: ReturnType<typeof createConverter>) => {
      converter.reset(); converter.init(manifest); converter.terrain(terrain);
      for (const [i, field] of manifest.fields.entries()) converter.field(field, geometry(fields[i]!, meridian, relative),
        { runTime, lead: 0, category: [3, 2, 2, 0][i]!, parameter: [5, 2, 3, 0][i]!, surface: 100, pressureHpa: 700 });
      return converter.finish().buffer;
    };
    const result = convert(reused);
    assert.deepEqual(result, convert(createConverter()), 'reused coefficients must match this geometry/orientation');
    for (const band of unpackGrid(result, manifest)) {
      const read = readBand(band);
      assert.equal(read(missing), GRID_MISSING); assert.equal(read(below), GRID_BELOW_GROUND);
      if (target.bounds === grid.bounds) assert.ok(Array.from({ length: count }, (_, i) => read(i)).includes(GRID_OUTSIDE));
    }
  }
});
