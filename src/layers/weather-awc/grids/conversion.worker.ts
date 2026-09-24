import { expose, transfer } from 'comlink';
import { decodeValues, decodeVerifiedValues } from './format';
import type { AwcGridFrame } from '@zlayer/contracts';
import type { NativeManifest } from './native-source';
import { WindInterpolation } from './wind-interpolation';
import { packGridBands, unpackGrid, inflatePacked, inflateGridBytes, compressGrid, readBand, type GridBand } from './packed';
import { readModelTerrain } from './model-terrain';
import { weatherTiming } from './performance';

let wind: { manifest: Pick<NativeManifest, 'grid' | 'fields' | 'product'>; values: Float32Array; interpolation: WindInterpolation } | undefined;
const api = {
  reset() { wind = undefined; },
  async decodePacked(compressed: ArrayBuffer, geometry: Pick<NativeManifest, 'grid' | 'fields'>) {
    const done = weatherTiming('inflate-validate');
    try {
      const buffer = await inflatePacked(compressed, geometry), bands = unpackGrid(buffer, geometry);
      return transfer({ buffer, bands }, [buffer]);
    } finally { done(); }
  },
  async encode(buffer: ArrayBuffer) {
    const done = weatherTiming('compress');
    try { const compressed = await compressGrid(buffer); return transfer(compressed, [compressed]); }
    finally { done(); }
  },
  async migrate(compressed: ArrayBuffer, geometry: Pick<NativeManifest, 'grid' | 'fields'>) {
    const values = await decodeValues(compressed, geometry, new AbortController().signal);
    const { buffer, bands } = packGridBands(values, geometry);
    return transfer({ buffer, bands }, [buffer]);
  },
  async decodeTerrain(compressed: ArrayBuffer, grid: NativeManifest['grid']) {
    const { values } = readModelTerrain(await inflateGridBytes(compressed, 168 + grid.width * grid.height * 4), grid);
    return transfer(values, [values.buffer]);
  },
  startWind(manifest: Pick<NativeManifest, 'grid' | 'fields' | 'product'>, altitude: number, terrain?: Float32Array) {
    if (manifest.product !== 'winds' || manifest.fields.join(',') !== 'windHeight,windEast,windNorth,temperature') throw new Error('Invalid wind interpolation fields');
    const values = new Float32Array(manifest.grid.width * manifest.grid.height * manifest.fields.length);
    wind = { manifest, values, interpolation: new WindInterpolation(altitude, values, terrain) };
  },
  windLevel(pressure: number, bands: GridBand[]) {
    if (!wind) throw new Error('Wind interpolation is not initialized');
    const count = wind.manifest.grid.width * wind.manifest.grid.height;
    if (bands.length !== 4 || bands.some(band => band.values.length !== count)) throw new Error('Invalid wind pressure geometry');
    const values = new Float32Array(count * 4);
    for (const [band, value] of bands.entries()) {
      const read = readBand(value);
      for (let i = 0; i < count; i++) values[band * count + i] = read(i);
    }
    return wind.interpolation.add(pressure, values);
  },
  async windSource(pressure: number, compressed: ArrayBuffer, frame: Pick<AwcGridFrame, 'bytes' | 'decodedBytes' | 'sha256'>) {
    if (!wind) throw new Error('Wind interpolation is not initialized');
    const values = await decodeVerifiedValues(compressed, wind.manifest, frame, new AbortController().signal);
    return wind.interpolation.add(pressure, values);
  },
  finishWind() {
    if (!wind) throw new Error('Wind interpolation is not initialized');
    const { manifest, values } = wind;
    wind = undefined;
    const done = weatherTiming('pack');
    try {
      const { buffer, bands } = packGridBands(values, manifest);
      return transfer({ buffer, bands }, [buffer]);
    } finally { done(); }
  },
};
expose(api);
export type GridConversionWorker = typeof api;
