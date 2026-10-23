import { AWC_GRID_FIELDS, type AwcGridProduct } from '@zlayer/contracts';
import { modelPath, parseGribIndex, HRRR_FIELDS, WIND_FIELDS, WIND_PRESSURES, SOURCE_ROOT, OUTPUT_GRID,
  type SourceRecord, type NativeFrame, type NativeManifest } from '../../src/layers/weather-awc/grids/native-source';
import { digest, type Payload } from './upstream';
import { HttpError, InvalidForecastIndexError } from './weather-resources';
import { isModelVersion, type ModelVersion, type ModelMirror } from '../../src/layers/weather-awc/grids/source-version';
type Row = ReturnType<typeof parseGribIndex>[number];
type Index = { path: string; lead: number; rows: Map<string, Row | null>; hash: string; version: ModelVersion };
export type ReadSource = (path: string, signal: AbortSignal, mirror?: ModelMirror) => Promise<Payload>;
const publicationGap = (error: unknown) => error instanceof InvalidForecastIndexError || error instanceof HttpError && [403, 404].includes(error.status);
function select(index: Index, parameter: string, surface: string): SourceRecord {
  const row = index.rows.get(`${parameter}:${surface}`);
  if (!row) throw new InvalidForecastIndexError(`NOAA forecast lacks an unambiguous ${parameter} / ${surface}`);
  if (row.time !== (index.lead === 0 ? 'anl' : `${index.lead} hour fcst`)) throw new InvalidForecastIndexError('NOAA field forecast time mismatch');
  const { start, end } = row;
  if (end !== undefined && end - start + 1 > 8 * 1024 * 1024) throw new InvalidForecastIndexError('NOAA field exceeds its byte limit');
  if (start >= index.version.byteLength || end !== undefined && end >= index.version.byteLength) throw new InvalidForecastIndexError(`${index.path}: NOAA index exceeds its model object`);
  return { path: index.path, start, ...(end === undefined ? {} : { end }), indexHash: index.hash, version: index.version };
}

/** The same index selection as the former PWA path, with shared server acquisition. */
export async function discover(read: ReadSource, product: AwcGridProduct, signal: AbortSignal, now = Date.now(),
  selection?: { runTime: number; lead?: number; mirror?: ModelMirror },
  rejected?: (runTime: number, mirror: ModelMirror | undefined, reason: string) => void): Promise<NativeManifest> {
  if (selection) return discoverRun(read, product, signal, selection.runTime, selection.lead, selection.mirror);
  const hour = Math.floor(now / 3600000) * 3600000;
  for (let age = 1; age <= 6; age++) {
    try { return await discoverRun(read, product, signal, hour - age * 3600000); }
    catch (error) {
      signal.throwIfAborted();
      // A mirror can contain a truncated object beside a complete index. Try one
      // independent NOAA mirror for this complete HRRR run before aging a cycle.
      // Transport errors/rate limits stop discovery; they cannot amplify probes.
      if (!publicationGap(error)) throw error;
      if (error instanceof InvalidForecastIndexError) rejected?.(hour - age * 3600000, undefined, error.message.slice(0, 300));
      if (product !== 'icing') {
        try { return await discoverRun(read, product, signal, hour - age * 3600000, undefined, 'noaa-hrrr-s3'); }
        catch (alternate) {
          signal.throwIfAborted();
          if (!publicationGap(alternate)) throw alternate;
          if (alternate instanceof InvalidForecastIndexError) rejected?.(hour - age * 3600000, 'noaa-hrrr-s3', alternate.message.slice(0, 300));
        }
      }
    }
  }
  throw new HttpError(502, 'No complete recent NOAA model run is available', 5);
}

async function discoverRun(read: ReadSource, product: AwcGridProduct, signal: AbortSignal,
  runTime: number, selectedLead?: number, mirror?: ModelMirror): Promise<NativeManifest> {
  if (mirror && product === 'icing') throw new Error('IFI has no HRRR mirror');
  let checkedAt = Infinity;
  const readIndex = async (product: AwcGridProduct, runTime: number, lead: number, signal: AbortSignal) => {
    const path = modelPath(product, runTime, lead), source = await read(path + '.idx', signal, mirror);
    checkedAt = Math.min(checkedAt, source.checkedAt);
    const rows = new Map<string, Row | null>();
    let parsed: Row[];
    try { parsed = parseGribIndex(source.body.toString('utf8'), runTime); }
    catch { throw new InvalidForecastIndexError('Invalid NOAA forecast index'); }
    for (const row of parsed) {
      const key = `${row.parameter}:${row.surface}`;
      rows.set(key, rows.has(key) ? null : row);
    }
    const metadata = await read(path, signal, mirror);
    let version: unknown;
    try { version = JSON.parse(metadata.body.toString()); } catch { /* Invalid metadata below. */ }
    if (!isModelVersion(version)) throw new InvalidForecastIndexError('NOAA model lacks a usable object version');
    checkedAt = Math.min(checkedAt, metadata.checkedAt);
    return { path, lead, rows, hash: digest(source.body), version: { ...version, ...(mirror ? { mirror } : {}) } };
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
        for (const field of AWC_GRID_FIELDS.clouds) {
          const { parameterName, surfaceName } = HRRR_FIELDS[field];
          records[field] = select(index, parameterName, surfaceName);
        }
        frames.push({ validTime: runTime + lead * 3600000, altitudeFtMsl: null, records, sources: [SOURCE_ROOT + index.path] });
      } else if (product === 'winds') {
        for (const pressureHpa of WIND_PRESSURES) {
          const records: NativeFrame['records'] = { terrain: terrain! };
          for (const field of AWC_GRID_FIELDS.winds) records[field] = select(index, WIND_FIELDS[field].parameterName, `${pressureHpa} mb`);
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
