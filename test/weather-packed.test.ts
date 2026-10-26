import assert from 'node:assert/strict';
import test from 'node:test';
import { AWC_GRID_FIELDS, GRID_MISSING, GRID_UNKNOWN, GRID_OUTSIDE, GRID_BELOW_GROUND } from '@zlayer/contracts';
import { packGrid, unpackGrid, readBand, compressGrid, inflatePacked } from '../src/layers/weather-awc/grids/packed';

test('compact bands round-trip exact Float32 values and all missing states without rounding interpolated fields', async () => {
  for (const product of ['clouds', 'icing', 'winds'] as const) {
    const geometry = { grid: { width: 17, height: 2 }, fields: AWC_GRID_FIELDS[product] };
    const count = geometry.grid.width * geometry.grid.height;
    const values = Float32Array.from({ length: count * geometry.fields.length }, (_, i) => {
      const field = geometry.fields[Math.floor(i / count)]!;
      const missing = [GRID_MISSING, GRID_UNKNOWN, GRID_OUTSIDE, GRID_BELOW_GROUND];
      if (i % count < 4) return missing[i % count]!;
      return field === 'sldPotential' ? (i % 101) / 100 : field === 'icingSeverity' ? i % 5
        : field === 'temperature' ? -32.1 : field === 'windEast' ? 12.34567 : field === 'windNorth' ? -45.6
        : field === 'cloudCover' || field === 'icingProbability' ? i % 101 : i * 10;
    });
    const packed = packGrid(values, geometry), bands = unpackGrid(packed, geometry);
    for (const [band, value] of bands.entries()) {
      const read = readBand(value);
      for (let cell = 0; cell < count; cell++) assert.equal(read(cell), values[band * count + cell]);
    }
    assert.deepEqual(await inflatePacked(await compressGrid(packed), geometry), packed);
    if (product === 'winds') assert.ok(bands[1]!.values instanceof Float32Array, 'unrounded interpolation keeps full precision');
  }
});

test('cloud and icing packing saves 55% and 75% of numeric bytes including format overhead', () => {
  for (const product of ['clouds', 'icing'] as const) {
    // Large enough to include header/alignment overhead in the ratio without
    // allocating full CONUS grids; independent NOAA references cover those sizes.
    const geometry = { grid: { width: 128, height: 128 }, fields: AWC_GRID_FIELDS[product] };
    const count = geometry.grid.width * geometry.grid.height;
    const values = Float32Array.from({ length: count * geometry.fields.length }, (_, i) => {
      const field = geometry.fields[Math.floor(i / count)];
      return field === 'sldPotential' ? .25 : field === 'icingSeverity' ? 3 : field === 'cloudCover' || field === 'icingProbability' ? 70 : 12340;
    });
    const packed = packGrid(values, geometry);
    assert.ok(packed.byteLength < values.byteLength * (product === 'clouds' ? .451 : .251));
  }
});

test('packed reader rejects mismatched geometry, fields, offsets, encoding, values and extra bytes', async () => {
  const geometry = { grid: { width: 2, height: 2 }, fields: AWC_GRID_FIELDS.icing };
  const good = packGrid(Float32Array.from([0, 25, 75, 100, 0, 1, 2, 3, 0, .25, .5, 1]), geometry);
  for (const change of [
    (v: DataView) => v.setUint16(10, 3, true),
    (v: DataView) => v.setUint8(16, 200),
    (v: DataView) => v.setUint8(17, 3),
    (v: DataView) => v.setUint32(20, 0, true),
    (v: DataView) => v.setUint8(52, 101),
    (v: DataView) => v.setUint8(56, 5),
  ]) {
    const bad = good.slice(0); change(new DataView(bad)); assert.throws(() => unpackGrid(bad, geometry));
  }
  const extra = new Uint8Array(good.byteLength + 4); extra.set(new Uint8Array(good));
  assert.throws(() => unpackGrid(extra.buffer, geometry));
  await assert.rejects(inflatePacked(await compressGrid(new ArrayBuffer(4096)), geometry), /limit/);
});

test('packing preserves late float fallback, canonical zero, padding and independent output ownership', () => {
  const geometry = { grid: { width: 3, height: 1 }, fields: ['cloudCover', 'windEast', 'temperature'] as const };
  const values = Float32Array.from([0, GRID_UNKNOWN, 100, 12.3, GRID_MISSING, 12.34567, -0, -32.1, GRID_OUTSIDE]);
  const packed = packGrid(values, geometry), bands = unpackGrid(packed, geometry);
  assert.ok(bands[0]!.values instanceof Uint8Array);
  assert.ok(bands[1]!.values instanceof Float32Array);
  assert.ok(bands[2]!.values instanceof Int16Array, 'integer encoding retains the existing canonical zero');
  assert.equal(new Uint8Array(packed)[55], 0, 'odd byte bands retain zero alignment padding');
  for (const [band, data] of bands.entries()) for (let cell = 0; cell < 3; cell++) {
    assert.ok(Object.is(readBand(data)(cell), values[band * 3 + cell] === 0 ? 0 : values[band * 3 + cell]));
  }
  values.fill(0);
  assert.equal(readBand(bands[1]!)(2), Math.fround(12.34567), 'float fallback copies its source');
  for (const invalid of [NaN, Infinity, 551]) {
    const bad = Float32Array.of(12.34567, invalid);
    assert.throws(() => packGrid(bad, { grid: { width: 2, height: 1 }, fields: ['windEast'] }), /Invalid packed grid value/,
      'fallback must still validate all later samples');
  }
});
