import { readFileSync } from 'node:fs';
import { AWC_GRID_FIELDS, type AwcGridField } from '@zlayer/contracts';
import { OUTPUT_GRID } from '../../src/layers/weather-awc/grids/native-source';
import type { GribIdentity } from '../../src/layers/weather-awc/grids/grib';
import reference from './awc-grib/reference.json';
import windReference from './awc-grib/wind-reference.json';

/** Retained NOAA fields with synthetic sea-level terrain. This isolates numeric
 * preparation; it does not model acquisition, mountainous masks or publication. */
export function forecastConversionFixture(product: 'winds' | 'icing') {
  const inputs = product === 'winds'
    ? ['windHeight', 'windEast', 'windNorth', 'temperature'].map((field, i) => ({ field, ...windReference.fields[[0, 2, 3, 1][i]!]! }))
    : ['icingProbability', 'icingSeverity', 'sldPotential'].map(field => reference.fields.find(item => item.field === field)!);
  const buffer = new ArrayBuffer(168 + OUTPUT_GRID.width * OUTPUT_GRID.height * 4);
  const signature = reference.fields[0]!.grid.signature;
  new DataView(buffer).setUint32(0, 1, true);
  new Uint8Array(buffer, 4, 162).set(new TextEncoder().encode(signature));
  return {
    manifest: { product, grid: OUTPUT_GRID, fields: AWC_GRID_FIELDS[product] },
    terrain: { buffer, signature, values: new Float32Array(buffer, 168) },
    inputs: inputs.map(item => ({ field: item.field as AwcGridField, sourceSha256: item.sourceSha256,
      identity: { ...item.identity, ...(product === 'icing' ? { altitude: 8000 } : {}) } as GribIdentity,
      raw: Uint8Array.from(readFileSync(new URL(`./awc-grib/${item.name}`, import.meta.url))).buffer })),
    // Captured from the preceding converter, whose source decode/projection has
    // independent GDAL references. These also pin the unchanged packed format.
    packedSha256: product === 'winds' ? '712e66c041e63c5f670f840dc6e06368c532e45894e09da16f1b029cdf93ce3d'
      : '1d640df2609d9e578a323ccbaafbc68b494a0174bcc7a432137813c6f38e9a55',
  };
}
