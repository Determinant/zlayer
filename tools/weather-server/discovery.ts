import { AWC_GRID_FIELDS, type AwcGridProduct } from '@zlayer/contracts';
import { modelPath, parseGribIndex, HRRR_FIELDS, WIND_FIELDS, WIND_PRESSURES, SOURCE_ROOT, OUTPUT_GRID,
  type SourceRecord, type NativeFrame, type NativeManifest } from '../../src/layers/weather-awc/grids/native-source';
import { digest, type Payload } from './upstream';
import { HttpError, InvalidForecastIndexError } from './routes';
type Row = ReturnType<typeof parseGribIndex>[number];
type Index = { path: string; lead: number; rows: Map<string, Row | null>; hash: string };
export type ReadSource = (path: string, signal: AbortSignal) => Promise<Payload>;
function select(index: Index, parameter: string, surface: string): SourceRecord {
  const row = index.rows.get(`${parameter}:${surface}`);
  if (!row) throw new InvalidForecastIndexError(`NOAA forecast lacks an unambiguous ${parameter} / ${surface}`);
  if (row.time !== (index.lead === 0 ? 'anl' : `${index.lead} hour fcst`)) throw new InvalidForecastIndexError('NOAA field forecast time mismatch');
  const { start, end } = row;
  if (end !== undefined && end - start + 1 > 8 * 1024 * 1024) throw new InvalidForecastIndexError('NOAA field exceeds its byte limit');
  return { path: index.path, start, ...(end === undefined ? {} : { end }), indexHash: index.hash };
}

/** The same index selection as the former PWA path, with shared server acquisition. */
export async function discover(read: ReadSource, product: AwcGridProduct, signal: AbortSignal, now = Date.now(),
  selection?: { runTime: number; lead?: number }): Promise<NativeManifest> {
  if (selection) return discoverRun(read, product, signal, selection.runTime, selection.lead);
  const hour = Math.floor(now / 3600000) * 3600000;
  for (let age = 1; age <= 6; age++) {
    try { return await discoverRun(read, product, signal, hour - age * 3600000); }
    catch (error) {
      signal.throwIfAborted();
      // Publication gaps can fall back; transport failures and rate limits cannot.
      if (!(error instanceof InvalidForecastIndexError) && !(error instanceof HttpError && [403, 404].includes(error.status))) throw error;
    }
  }
  throw new HttpError(502, 'No complete recent NOAA model run is available', 5);
}

async function discoverRun(read: ReadSource, product: AwcGridProduct, signal: AbortSignal,
  runTime: number, selectedLead?: number): Promise<NativeManifest> {
  let checkedAt = Infinity;
  const readIndex = async (product: AwcGridProduct, runTime: number, lead: number, signal: AbortSignal) => {
    const path = modelPath(product, runTime, lead), source = await read(path + '.idx', signal);
    checkedAt = Math.min(checkedAt, source.checkedAt);
    const rows = new Map<string, Row | null>();
    let parsed: Row[];
    try { parsed = parseGribIndex(source.body.toString('utf8'), runTime); }
    catch { throw new InvalidForecastIndexError('Invalid NOAA forecast index'); }
    for (const row of parsed) {
      const key = `${row.parameter}:${row.surface}`;
      rows.set(key, rows.has(key) ? null : row);
    }
    return { path, lead, rows, hash: digest(source.body) };
  };
  signal.throwIfAborted();
  const latest = await readIndex(product, runTime, selectedLead ?? 18, signal);
  const frames: NativeFrame[] = [], fields = AWC_GRID_FIELDS[product];
  const terrainIndex = product !== 'clouds' ? await readIndex('clouds', runTime, 0, signal) : undefined;
  const terrain = terrainIndex && select(terrainIndex, 'HGT', 'surface');
  const first = selectedLead ?? (product === 'icing' ? 1 : 0), last = selectedLead ?? 18;
  for (let start = first; start <= last; start += 4) {
    signal.throwIfAborted();
    // Read small independent indexes in batches of four. Keep only
    // this bounded batch while validating the complete published horizon.
    const batch = new AbortController(), combined = AbortSignal.any([signal, batch.signal]);
    let indexes: Awaited<ReturnType<typeof readIndex>>[];
    try { indexes = await Promise.all(Array.from({ length: Math.min(4, last + 1 - start) }, (_, i) =>
      start + i === (selectedLead ?? 18) ? latest : readIndex(product, runTime, start + i, combined))); }
    catch (error) { batch.abort(); throw error; }
    for (const index of indexes) {
      const lead = index.lead;
      if (product === 'clouds') {
        const records: NativeFrame['records'] = {};
        for (const field of AWC_GRID_FIELDS.clouds) records[field] = select(index, HRRR_FIELDS[field][0], HRRR_FIELDS[field][1]);
        frames.push({ validTime: runTime + lead * 3600000, altitudeFtMsl: null, records, sources: [SOURCE_ROOT + index.path] });
      } else if (product === 'winds') {
        for (const pressureHpa of WIND_PRESSURES) {
          const records: NativeFrame['records'] = { terrain: terrain! };
          for (const field of AWC_GRID_FIELDS.winds) records[field] = select(index, WIND_FIELDS[field][0], `${pressureHpa} mb`);
          frames.push({ validTime: runTime + lead * 3600000, altitudeFtMsl: null, pressureHpa, records,
            sources: [SOURCE_ROOT + index.path, SOURCE_ROOT + terrainIndex!.path] });
        }
      } else {
        for (let altitude = 500; altitude <= 30000; altitude += 500) {
          const surface = `${Number((altitude * 0.3048).toFixed(1))} m above mean sea level`;
          const records: NativeFrame['records'] = { terrain: terrain! };
          records.icingProbability = select(index, 'ICPRB', surface);
          records.sldPotential = select(index, 'SIPD', surface);
          records.icingSeverity = select(index, 'var discipline=0 master_table=2 parmcat=19 parm=37', surface);
          frames.push({ validTime: runTime + lead * 3600000, altitudeFtMsl: altitude, records,
            sources: [SOURCE_ROOT + index.path, SOURCE_ROOT + terrainIndex!.path] });
        }
      }
    }
  }
  return { schemaVersion: 1, encoding: 'grib2', product, model: product === 'icing' ? 'IFI' : 'HRRR',
    generation: `${product}-${runTime}`, runTime, checkedAt, publishedAt: checkedAt,
    cadenceMs: 3600000, grid: OUTPUT_GRID, fields, frames };
}
