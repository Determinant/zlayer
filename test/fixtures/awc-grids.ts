import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { AWC_GRID_FIELDS, GRID_BELOW_GROUND, type AwcGridManifest, type AwcGridProduct } from '@zlayer/contracts';
import { WEATHER_NOW } from './awc-advisories';

/** Synthetic numeric fields only; values deliberately differ across time and altitude. */
export function gridFixture(product: AwcGridProduct, revision = 1, now = WEATHER_NOW, icingLevels: readonly number[] = [500, 8000, 12000]) {
  const fields = AWC_GRID_FIELDS[product], width = 8, height = 6, count = width * height;
  const manifest: AwcGridManifest = { schemaVersion: 1, product, model: product === 'icing' ? 'IFI' : 'HRRR',
    generation: `${product}-synthetic-${revision}`, runTime: now - 3600000, checkedAt: now, publishedAt: now,
    cadenceMs: 3600000, grid: { projection: 'EPSG:3857', width, height, bounds: [-126, 22, -65, 51] }, fields, frames: [] };
  const files: Record<string, string> = {};
  for (const lead of product === 'icing' ? [1, 2, 4] : [0, 1, 2, 4]) for (const altitude of product === 'clouds' ? [null] : product === 'winds' ? [850, 700] : icingLevels) {
    const data = Buffer.alloc(16 + count * fields.length * 4);
    data.write('ZAWCGRID'); data.writeUInt16LE(1, 8); data.writeUInt16LE(width, 10); data.writeUInt16LE(height, 12); data.writeUInt16LE(fields.length, 14);
    const values = product === 'clouds' ? [75, 2000 + lead * 100, 18000, 9000, 12000]
      : product === 'winds' ? [altitude === 850 ? 4500 : 10000, 20 + lead * 5, -10, 10 - lead * 5]
      : altitude === 500 ? [GRID_BELOW_GROUND, GRID_BELOW_GROUND, GRID_BELOW_GROUND]
      : [altitude === 12000 ? 50 : 70 + lead, 3, 0.25];
    for (let band = 0; band < fields.length; band++) for (let cell = 0; cell < count; cell++) data.writeFloatLE(values[band]! + (band === 0 && values[band]! >= 0 ? revision - 1 : 0), 16 + (band * count + cell) * 4);
    const bytes = gzipSync(data), path = `runs/${manifest.generation}/f${lead}-${altitude ?? 'all'}.zwg.gz`;
    manifest.frames.push({ validTime: manifest.runTime + lead * 3600000, altitudeFtMsl: product === 'winds' ? null : altitude, ...(product === 'winds' ? { pressureHpa: altitude! } : {}), path,
      bytes: bytes.length, decodedBytes: data.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      sources: ['https://nomads.ncep.noaa.gov/synthetic-test.grib2'] });
    files[path] = bytes.toString('base64');
  }
  return { manifest, files };
}
