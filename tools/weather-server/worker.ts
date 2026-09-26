import { parentPort } from 'node:worker_threads';
import { createConverter } from './converter';
import { HRRR_FIELDS, IFI_PARAMETERS, WIND_FIELDS, type NativeFrame, type SourceRecord } from '../../src/layers/weather-awc/grids/native-source';
import { compressGrid } from '../../src/layers/weather-awc/grids/packed';
import { workerFailure, type ConversionJob, type ConversionRequest, type ConversionResponse } from './worker-protocol';
import type { AwcGridField } from '@zlayer/contracts';
import type { GribIdentity } from '../../src/layers/weather-awc/grids/grib';

function fieldIdentity(field: AwcGridField, frame: NativeFrame): Omit<GribIdentity, 'runTime' | 'lead'> {
  if (field in HRRR_FIELDS) {
    const { category, parameter, surface } = HRRR_FIELDS[field as keyof typeof HRRR_FIELDS];
    return { category, parameter, surface };
  }
  if (field in WIND_FIELDS) {
    const { category, parameter } = WIND_FIELDS[field as keyof typeof WIND_FIELDS];
    return { category, parameter, surface: 100, pressureHpa: frame.pressureHpa! };
  }
  return { category: 19, parameter: IFI_PARAMETERS[field as keyof typeof IFI_PARAMETERS], surface: 102, altitude: frame.altitudeFtMsl! };
}

const converter = createConverter();
const terrain = new Map<string, ArrayBuffer>();
let serial = 0;
const reads = new Map<number, (value: ArrayBuffer) => void>();
const read = (record: SourceRecord) => new Promise<ArrayBuffer>(resolve => {
  const id = ++serial; reads.set(id, resolve); parentPort!.postMessage({ type: 'read', id, record } satisfies ConversionResponse);
});
async function convert({ product, manifest, frame, terrainOnly }: ConversionJob) {
  converter.reset();
  if (product !== 'clouds') {
    const record = frame.records.terrain, key = JSON.stringify([manifest.grid, record]);
    let prepared = terrain.get(key);
    if (!prepared) {
      prepared = converter.prepareTerrain(await read(record), { runTime: manifest.runTime, lead: 0, category: 3, parameter: 5, surface: 1 }, manifest.grid);
      terrain.set(key, prepared);
      while (terrain.size > 2) terrain.delete(terrain.keys().next().value!);
    }
    if (terrainOnly) return compressGrid(prepared);
    converter.init(manifest); converter.terrain(prepared);
  } else converter.init(manifest);
  const readLevel = async (level: NativeFrame) => {
    for (let start = 0; start < manifest.fields.length; start += 2) {
      const fields = manifest.fields.slice(start, start + 2), records = await Promise.all(fields.map(field => read(level.records[field]!)));
      for (const [index, field] of fields.entries()) {
        const identity = fieldIdentity(field, level);
        converter.field(field, records[index]!, { ...identity, runTime: manifest.runTime, lead: (frame.validTime - manifest.runTime) / 3600000 });
      }
    }
  };
  await readLevel(frame);
  const { buffer } = converter.finish();
  const result = await compressGrid(buffer);
  converter.reset();
  return result;
}
parentPort!.on('message', (message: ConversionRequest) => {
  if (message.type === 'read') {
    const pending = reads.get(message.id); reads.delete(message.id);
    pending?.(message.body);
    return;
  }
  void convert(message.job).then(body => parentPort!.postMessage({ type: 'done', value: body } satisfies ConversionResponse, [body]),
    error => parentPort!.postMessage(workerFailure(error)));
});
