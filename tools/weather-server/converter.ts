import { GRID_BELOW_GROUND, GRID_MISSING, GRID_OUTSIDE, type AwcGridField } from '@zlayer/contracts';
import { decodeGrib, lambertGeometrySignature, type GribIdentity, type LambertGrid } from '../../src/layers/weather-awc/grids/grib';
import { samplingMap, projectField, rotateWinds } from '../../src/layers/weather-awc/grids/conversion';
import type { NativeManifest } from '../../src/layers/weather-awc/grids/native-source';
import { packGridBands } from '../../src/layers/weather-awc/grids/packed';
import { readModelTerrain } from '../../src/layers/weather-awc/grids/model-terrain';
import { weatherTiming } from '../../src/layers/weather-awc/grids/performance';

export function createConverter() {
  let manifest: Pick<NativeManifest, 'grid' | 'fields' | 'product'>, values: Float32Array<ArrayBuffer>, indices: Int32Array | undefined, signature = '';
  let terrain: Float32Array | undefined;
  let windGrid: LambertGrid | undefined;
  const received = new Set<string>();
  let mappingKey = '';
  function mapping(source: LambertGrid, target: NativeManifest['grid']) {
    const key = lambertGeometrySignature(source.signature) + JSON.stringify(target);
    if (key !== mappingKey) { indices = samplingMap(source, target); mappingKey = key; }
    return indices!;
  }
  return {
    reset() {
      values = new Float32Array(0); terrain = undefined; signature = ''; windGrid = undefined;
      received.clear();
    },
    prepareTerrain(raw: ArrayBuffer, identity: GribIdentity, grid: NativeManifest['grid']) {
      const field = decodeGrib(raw, identity), map = mapping(field.grid, grid);
      // Fixed 168-byte header: version, 162 ASCII grid-signature bytes, two padding bytes.
      if (field.grid.signature.length !== 162) throw new Error('Unexpected model terrain geometry');
      const artifact = new ArrayBuffer(168 + map.length * 4), values = new Float32Array(artifact, 168);
      new DataView(artifact).setUint32(0, 1, true);
      new Uint8Array(artifact, 4, 162).set(new TextEncoder().encode(field.grid.signature));
      for (let i = 0; i < map.length; i++) {
        const value = map[i]! < 0 ? NaN : field.values[map[i]!]!;
        if (!Number.isNaN(value) && (!Number.isFinite(value) || value < -500 || value > 10000)) throw new Error('Invalid model terrain height');
        values[i] = value;
      }
      return artifact;
    },
    terrain(artifact: ArrayBuffer) {
      const decoded = readModelTerrain(artifact, manifest.grid);
      signature = decoded.signature; terrain = decoded.values; received.add('terrain');
    },
    init(value: Pick<NativeManifest, 'grid' | 'fields' | 'product'>) {
      manifest = value;
      const { width, height } = value.grid;
      values = new Float32Array(width * height * value.fields.length);
      received.clear(); if (terrain) received.add('terrain'); windGrid = undefined;
    },
    field(field: AwcGridField, raw: ArrayBuffer, identity: GribIdentity) {
      const done = weatherTiming('grib-project');
      try {
      const decoded = decodeGrib(raw, identity);
      if (signature && lambertGeometrySignature(signature) !== lambertGeometrySignature(decoded.grid.signature)) throw new Error('NOAA field grids do not match');
      signature = decoded.grid.signature;
      indices = mapping(decoded.grid, manifest.grid);
      const band = manifest.fields.indexOf(field);
      if (band < 0 || received.has(field) || manifest.product !== 'clouds' && !terrain) throw new Error('Unexpected NOAA field order');
      const count = indices.length;
      projectField(field, decoded.values, indices, values.subarray(band * count, (band + 1) * count), terrain, identity.altitude,
        field === 'icingSeverity' ? values.subarray(0, count) : undefined);
      if (manifest.product === 'winds') {
        const target = values.subarray(band * count, (band + 1) * count);
        if (field !== 'windHeight' && !received.has('windHeight')) throw new Error('Wind heights must precede samples');
        for (let i = 0; i < count; i++) {
          if (indices[i]! < 0) continue;
          if (field === 'windHeight') {
            if (Number.isNaN(terrain![i])) target[i] = GRID_MISSING;
            else if (decoded.values[indices[i]!]! <= terrain![i]!) target[i] = GRID_BELOW_GROUND;
          } else if (values[i]! <= GRID_OUTSIDE) target[i] = values[i]!;
        }
        if (field === 'windEast') windGrid = decoded.grid;
        if (field === 'windNorth') {
          if (!windGrid || windGrid.gridRelative !== decoded.grid.gridRelative) throw new Error('Wind components have different orientations');
          rotateWinds(windGrid, indices, values.subarray(count, 2 * count), target);
        }
      }
      received.add(field);
      } finally { done(); }
    },
    finish() {
      if (manifest.fields.some(field => !received.has(field))) throw new Error('Incomplete converted forecast');
      const done = weatherTiming('pack');
      try {
        const { buffer, bands } = packGridBands(values, manifest);
        values = new Float32Array(0);
        return { buffer, bands };
      } finally { done(); }
    },
  };
}
