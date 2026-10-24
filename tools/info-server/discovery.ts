import { AWC_GRID_FIELDS, type AwcGridProduct } from '@zlayer/contracts';
import { modelPath, parseGribIndex, HRRR_FIELDS, WIND_FIELDS, WIND_PRESSURES, SOURCE_ROOT, OUTPUT_GRID,
  type SourceRecord, type NativeFrame, type NativeManifest } from '../../src/layers/weather-awc/grids/native-source';
import { digest, type Payload } from './upstream';
import { HttpError, InvalidForecastIndexError } from './weather-resources';
import { isModelVersion, type ModelVersion, type ModelMirror } from '../../src/layers/weather-awc/grids/source-version';
type Row = ReturnType<typeof parseGribIndex>[number];
type Index = { path: string; lead: number; rows: Map<string, Row | null>; hash: string; version: ModelVersion; checkedAt: number };
export type ReadSource = (path: string, signal: AbortSignal, mirror?: ModelMirror) => Promise<Payload>;
type Provider = ModelMirror | 'google-hrrr' | 'nomads-ifi';
type Rejected = (runTime: number, provider: Provider, reason: string) => void;
type RunSelection = { runTime: number; lead?: number; mirror?: ModelMirror };
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
  selection?: RunSelection,
  rejected?: Rejected): Promise<NativeManifest> {
  if (selection) return discoverRun(read, product, signal, selection, rejected);
  const hour = Math.floor(now / 3600000) * 3600000;
  for (let age = 1; age <= 6; age++) {
    const runTime = hour - age * 3600000;
    try { return await discoverRun(read, product, signal, { runTime, terrainFallback: true }, rejected); }
    catch (error) {
      signal.throwIfAborted();
      // A mirror can contain a truncated object beside a complete index. Try one
      // independent NOAA mirror for this complete HRRR run before aging a cycle.
      // Transport errors/rate limits stop discovery; they cannot amplify probes.
      if (!publicationGap(error)) throw error;
      if (product !== 'icing') {
        try { return await discoverRun(read, product, signal, { runTime, mirror: 'noaa-hrrr-s3' }, rejected); }
        catch (alternate) {
          signal.throwIfAborted();
          if (!publicationGap(alternate)) throw alternate;
        }
      }
    }
  }
  throw new HttpError(502, 'No complete recent NOAA model run is available', 5);
}

async function discoverRun(read: ReadSource, product: AwcGridProduct, signal: AbortSignal,
  { runTime, lead: selectedLead, mirror, terrainFallback = false }: RunSelection & { terrainFallback?: boolean },
  rejected?: Rejected): Promise<NativeManifest> {
  if (mirror && product === 'icing') throw new Error('IFI has no HRRR mirror');
  let provider: Provider = mirror ?? (product === 'icing' ? 'nomads-ifi' : 'google-hrrr');
  const report = (source: Provider, error: unknown) => {
    if (error instanceof InvalidForecastIndexError) rejected?.(runTime, source, error.message.slice(0, 300));
  };
  const readIndex = async (product: AwcGridProduct, runTime: number, lead: number, signal: AbortSignal, sourceMirror = mirror): Promise<Index> => {
    const path = modelPath(product, runTime, lead), source = await read(path + '.idx', signal, sourceMirror);
    const rows = new Map<string, Row | null>();
    let parsed: Row[];
    try { parsed = parseGribIndex(source.body.toString('utf8'), runTime); }
    catch { throw new InvalidForecastIndexError('Invalid NOAA forecast index'); }
    for (const row of parsed) {
      const key = `${row.parameter}:${row.surface}`;
      rows.set(key, rows.has(key) ? null : row);
    }
    const metadata = await read(path, signal, sourceMirror);
    let version: unknown;
    try { version = JSON.parse(metadata.body.toString()); } catch { /* Invalid metadata below. */ }
    if (!isModelVersion(version)) throw new InvalidForecastIndexError('NOAA model lacks a usable object version');
    return { path, lead, rows, hash: digest(source.body), checkedAt: Math.min(source.checkedAt, metadata.checkedAt),
      version: { ...version, ...(sourceMirror ? { mirror: sourceMirror } : {}) } };
  };
  const readTerrain = async (sourceMirror = mirror) => {
    const index = await readIndex('clouds', runTime, 0, signal, sourceMirror);
    return { index, record: select(index, 'HGT', 'surface') };
  };
  try {
    signal.throwIfAborted();
    const latest = await readIndex(product, runTime, selectedLead ?? 18, signal);
    const frames: NativeFrame[] = [], fields = AWC_GRID_FIELDS[product];
    let terrainSource: Awaited<ReturnType<typeof readTerrain>> | undefined;
    if (product !== 'clouds') {
      try { terrainSource = await readTerrain(); }
      catch (error) {
        provider = mirror ?? 'google-hrrr'; signal.throwIfAborted();
        // IFI fields have no alternate, but their same-cycle HRRR terrain does.
        // Pinned selections and transport failures never change provider.
        if (product !== 'icing' || !terrainFallback || !publicationGap(error)) throw error;
        report(provider, error); provider = 'noaa-hrrr-s3';
        terrainSource = await readTerrain('noaa-hrrr-s3');
        provider = 'nomads-ifi';
      }
    }
    const terrainIndex = terrainSource?.index, terrain = terrainSource?.record;
    let checkedAt = Math.min(latest.checkedAt, terrainIndex?.checkedAt ?? Infinity);
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
        checkedAt = Math.min(checkedAt, index.checkedAt);
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
  } catch (error) { report(provider, error); throw error; }
}
