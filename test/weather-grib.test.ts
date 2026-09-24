import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { AwcGridField } from '@zlayer/contracts';
import { decodeGrib } from '../src/layers/weather-awc/grids/grib';
import { samplingMap, projectField } from '../src/layers/weather-awc/grids/conversion';
import { OUTPUT_GRID, parseGribIndex, modelPath, nativeSourceUrl } from '../src/layers/weather-awc/grids/native-source';
import reference from './fixtures/awc-grib/reference.json';
import { packGrid, unpackGrid, readBand } from '../src/layers/weather-awc/grids/packed';

for (const item of reference.fields) test(`NOAA ${item.field}: every converted cell agrees with the independent GDAL reference`, () => {
  const raw = Uint8Array.from(readFileSync(new URL(`./fixtures/awc-grib/${item.name}`, import.meta.url))).buffer;
  assert.equal(createHash('sha256').update(new Uint8Array(raw)).digest('hex'), item.sourceSha256);
  const decoded = decodeGrib(raw, item.identity), indices = samplingMap(decoded.grid, OUTPUT_GRID);
  const values = new Float32Array(indices.length);
  projectField(item.field as AwcGridField, decoded.values, indices, values);
  assert.equal(createHash('sha256').update(new Uint8Array(values.buffer)).digest('hex'), item.expectedSha256);
  const geometry = { grid: OUTPUT_GRID, fields: [item.field as AwcGridField] };
  const read = readBand(unpackGrid(packGrid(values, geometry), geometry)[0]!);
  const restored = Float32Array.from({ length: values.length }, (_, cell) => read(cell));
  assert.equal(createHash('sha256').update(new Uint8Array(restored.buffer)).digest('hex'), item.expectedSha256,
    'compact storage preserves every independently verified NOAA sample');
  assert.throws(() => decodeGrib(raw, { ...item.identity, lead: item.identity.lead + 1 }), /identity/);
  const wrongPacking = raw.slice(0), view = new DataView(wrongPacking);
  for (let i = 16; i < raw.byteLength - 4; i += view.getUint32(i)) if (view.getUint8(i + 4) === 5) { view.setUint16(i + 9, 40); break; }
  assert.throws(() => decodeGrib(wrongPacking, item.identity), /packing/);
  assert.throws(() => decodeGrib(raw.slice(0, -1), item.identity), /framing/);
});

test('NOAA indexes pin source cycles and ordered exact byte ranges', () => {
  const run = Date.UTC(2026, 8, 23);
  const source = '1:0:d=2026092300:TCDC:entire atmosphere:1 hour fcst:\n2:500:d=2026092300:HGT:cloud base:1 hour fcst:\n';
  assert.deepEqual(parseGribIndex(source, run).map(row => [row.start, row.end]), [[0,499],[500,undefined]]);
  assert.throws(() => parseGribIndex(source, run + 3600000), /index/);
  assert.throws(() => parseGribIndex(source.replace('2:500:', '2:0:'), run), /ranges/);
  assert.match(modelPath('icing', run, 1), /dafs\.20260923\/dafs\.t00z\.ifi\.3km\.conus\.f001\.grib2$/);
  const baseUrl = 'https://app.test/weather/noaa/';
  assert.equal(nativeSourceUrl(baseUrl, modelPath('icing', run, 1)), `${baseUrl}${modelPath('icing', run, 1)}`);
  const hrrr = new URL(nativeSourceUrl(baseUrl, modelPath('clouds', run, 1)));
  assert.equal(hrrr.origin, 'https://storage.googleapis.com');
  assert.equal(hrrr.search, '?alt=media');
});
