import { parentPort } from 'node:worker_threads';
import { createConverter } from './converter';
import { HRRR_FIELDS, IFI_PARAMETERS, WIND_FIELDS, type NativeFrame, type NativeManifest, type SourceRecord } from '../../src/layers/weather-awc/grids/native-source';
import { compressGrid } from '../../src/layers/weather-awc/grids/packed';

const converter = createConverter();
const terrain = new Map<string, ArrayBuffer>();
let serial = 0;
const reads = new Map<number, { resolve: (value: ArrayBuffer) => void; reject: (error: Error) => void }>();
const read = (record: SourceRecord) => new Promise<ArrayBuffer>((resolve, reject) => {
  const id = ++serial; reads.set(id, { resolve, reject }); parentPort!.postMessage({ type: 'read', id, record });
});
export type ConversionJob = { manifest: NativeManifest; frame: NativeFrame; terrainOnly?: boolean };
async function convert({ manifest, frame, terrainOnly }: ConversionJob) {
  converter.reset();
  if (manifest.product !== 'clouds') {
    const record = frame.records.terrain!, key = JSON.stringify([manifest.grid, record]);
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
        const identity = field in HRRR_FIELDS ? (() => {
          const info = HRRR_FIELDS[field as keyof typeof HRRR_FIELDS];
          return { category: info[2], parameter: info[3], surface: info[4] };
        })() : field in WIND_FIELDS ? (() => {
          const info = WIND_FIELDS[field as keyof typeof WIND_FIELDS];
          return { category: info[1], parameter: info[2], surface: 100, pressureHpa: level.pressureHpa! };
        })() : { category: 19, parameter: IFI_PARAMETERS[field as keyof typeof IFI_PARAMETERS], surface: 102, altitude: level.altitudeFtMsl! };
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
parentPort!.on('message', message => {
  if (message.type === 'read') {
    const pending = reads.get(message.id); reads.delete(message.id);
    if (message.error) pending?.reject(new Error(message.error)); else pending?.resolve(message.body);
    return;
  }
  void convert(message.job).then(body => parentPort!.postMessage({ type: 'done', body }, [body]),
    error => parentPort!.postMessage({ type: 'done', error: String(error) }));
});
