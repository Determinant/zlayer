import { AWC_GRID_FIELDS, isRecord, type AwcGridFrame, type AwcGridManifest, type AwcGridProduct, type AwcGridField } from '@zlayer/contracts';

export const CONVERTER_VERSION = 'grib-browser-v1';
export type SourceRecord = { path: string; start: number; end?: number; indexHash: string };
export type NativeFrame = { validTime: number; altitudeFtMsl: number | null; pressureHpa?: number; sources: string[];
  records: Partial<Record<AwcGridField | 'terrain', SourceRecord>> };
export type NativeManifest = Omit<AwcGridManifest, 'frames'> & { encoding: 'grib2'; frames: NativeFrame[] };
export type ForecastManifest = AwcGridManifest | NativeManifest;
export type SourceFrame = AwcGridFrame | NativeFrame;
export type WindFrame<L extends SourceFrame = SourceFrame> = { validTime: number; windAltitude: number; altitudeFtMsl: number | null; pressureHpa?: number;
  sources: string[]; levels: L[] };
export type ForecastFrame = SourceFrame | WindFrame;
export const nativeManifest = (manifest: ForecastManifest): manifest is NativeManifest => 'encoding' in manifest && manifest.encoding === 'grib2';
export const SOURCE_ROOT = 'https://nomads.ncep.noaa.gov/pub/data/nccf/com/';
// Retained source-addressed browser cache identity. The server reads the same
// Google bucket through its ordinary object URL; the PWA downloads prepared grids.
export const HRRR_DOWNLOAD_ROOT = 'https://storage.googleapis.com/download/storage/v1/b/high-resolution-rapid-refresh/o/';
/** Source-addressed offline identity, not a browser acquisition URL. */
export function nativeSourceUrl(baseUrl: string, path: string): string {
  if (path.startsWith('hrrr/prod/')) return `${HRRR_DOWNLOAD_ROOT}${encodeURIComponent(path.slice('hrrr/prod/'.length))}?alt=media`;
  return new URL(path, baseUrl).href;
}
export const HRRR_FIELDS = {
  cloudCover: { parameterName: 'TCDC', surfaceName: 'entire atmosphere', category: 6, parameter: 1, surface: 10 },
  cloudBase: { parameterName: 'HGT', surfaceName: 'cloud base', category: 3, parameter: 5, surface: 2 },
  cloudTop: { parameterName: 'HGT', surfaceName: 'cloud top', category: 3, parameter: 5, surface: 3 },
  freezingLowest: { parameterName: 'HGT', surfaceName: '0C isotherm', category: 3, parameter: 5, surface: 4 },
  freezingHighest: { parameterName: 'HGT', surfaceName: 'highest tropospheric freezing level', category: 3, parameter: 5, surface: 204 },
  terrain: { parameterName: 'HGT', surfaceName: 'surface', category: 3, parameter: 5, surface: 1 },
} as const;
export const IFI_PARAMETERS = { icingProbability: 233, icingSeverity: 37, sldPotential: 217 } as const;
export const WIND_FIELDS = {
  windHeight: { parameterName: 'HGT', category: 3, parameter: 5 },
  windEast: { parameterName: 'UGRD', category: 2, parameter: 2 },
  windNorth: { parameterName: 'VGRD', category: 2, parameter: 3 },
  temperature: { parameterName: 'TMP', category: 0, parameter: 0 },
} as const;
export const WIND_PRESSURES = Array.from({ length: 37 }, (_, i) => 1000 - i * 25);
export function modelPath(product: AwcGridProduct, runTime: number, lead: number): string {
  const date = new Date(runTime).toISOString(), day = date.slice(0, 10).replaceAll('-', ''), hour = date.slice(11, 13);
  return product !== 'icing' ? `hrrr/prod/hrrr.${day}/conus/hrrr.t${hour}z.wrf${product === 'winds' ? 'prs' : 'sfc'}f${String(lead).padStart(2, '0')}.grib2`
    : `dafs/prod/dafs.${day}/dafs.t${hour}z.ifi.3km.conus.f${String(lead).padStart(3, '0')}.grib2`;
}
// Canonical 4096 m Mercator grid enclosing [-126, 22, -65, 51]. Runtime
// transcendental rounding differs between Node and browsers; geometry is wire data.
export const OUTPUT_GRID: AwcGridManifest['grid'] = { projection: 'EPSG:3857', width: 1658, height: 1004,
  bounds: [-126, 21.978213637213482, -64.99389988576598, 51] };

type IndexRow = { start: number; end?: number; parameter: string; surface: string; time: string };
export function parseGribIndex(text: string, runTime: number): IndexRow[] {
  const expected = new Date(runTime).toISOString().slice(0, 13).replace(/[-T]/g, '');
  const rows = text.trim().split(/\r?\n/).map((line, index) => {
    const p = line.split(':'), start = Number(p[1]);
    // Unselected HRRR accumulated/averaged products have different time text.
    // The selected field's exact lead is checked by select().
    if (p.length < 6 || p[0] !== String(index + 1) || !Number.isSafeInteger(start) || start < 0 || p[2] !== `d=${expected}`) throw new Error('Invalid NOAA forecast index');
    return { start, parameter: p[3]!, surface: p[4]!, time: p[5]! };
  });
  if (!rows.length || rows.length > 2000 || rows[0]!.start !== 0) throw new Error('Incomplete NOAA forecast index');
  return rows.map((row, i) => {
    const next = rows[i + 1];
    if (next && next.start <= row.start) throw new Error('Ambiguous NOAA index ranges');
    return { ...row, ...(next ? { end: next.start - 1 } : {}) };
  });
}
export function isNativeManifest(value: unknown): value is NativeManifest {
  if (!isRecord(value) || value.encoding !== 'grib2' || value.schemaVersion !== 1 ||
    !['clouds', 'icing', 'winds'].includes(String(value.product)) || !Number.isSafeInteger(value.runTime) || Number(value.runTime) <= 0 || Number(value.runTime) % 3600000 ||
    !Number.isSafeInteger(value.checkedAt) || Number(value.checkedAt) < Number(value.runTime) || value.publishedAt !== value.checkedAt ||
    value.cadenceMs !== 3600000 || !isRecord(value.grid) || value.grid.projection !== OUTPUT_GRID.projection ||
    value.grid.width !== OUTPUT_GRID.width || value.grid.height !== OUTPUT_GRID.height || !Array.isArray(value.grid.bounds) || value.grid.bounds.length !== 4 ||
    // Accept the last-bit difference in previously saved browser-generated catalogs.
    !value.grid.bounds.every((bound, i) => typeof bound === 'number' && Math.abs(bound - OUTPUT_GRID.bounds[i]!) < 1e-10)) return false;
  const product = value.product as AwcGridProduct, runTime = value.runTime as number;
  const levels = product === 'icing' ? 60 : product === 'winds' ? WIND_PRESSURES.length : 1;
  const expected = levels * (product === 'icing' ? 18 : 19);
  if (value.model !== (product === 'icing' ? 'IFI' : 'HRRR') || value.generation !== `${product}-${runTime}` ||
    JSON.stringify(value.fields) !== JSON.stringify(AWC_GRID_FIELDS[product]) || !Array.isArray(value.frames) ||
    value.frames.length !== expected) return false;
  const seen = new Set<string>(), hours = new Map<number, number>();
  for (const f of value.frames) {
    if (!isRecord(f) || !Number.isSafeInteger(f.validTime) || !isRecord(f.records)) return false;
    const lead = (Number(f.validTime) - runTime) / 3600000, altitude = f.altitudeFtMsl;
    if (!Number.isInteger(lead) || lead < (product === 'icing' ? 1 : 0) || lead > 18 ||
      (product === 'icing' ? typeof altitude !== 'number' || altitude < 500 || altitude > 30000 || altitude % 500 : altitude !== null) ||
      (product === 'winds' ? !WIND_PRESSURES.includes(Number(f.pressureHpa)) || typeof f.pressureHpa !== 'number' : f.pressureHpa !== undefined)) return false;
    const paths = [modelPath(product, runTime, lead), ...(product !== 'clouds' ? [modelPath('clouds', runTime, 0)] : [])];
    if (JSON.stringify(f.sources) !== JSON.stringify(paths.map(path => SOURCE_ROOT + path))) return false;
    for (const field of [...AWC_GRID_FIELDS[product], ...(product !== 'clouds' ? ['terrain'] : [])]) {
      const r = f.records[field];
      if (!isRecord(r) || r.path !== paths[field === 'terrain' ? 1 : 0] || typeof r.indexHash !== 'string' || !/^[a-f0-9]{64}$/.test(r.indexHash) ||
        !Number.isSafeInteger(r.start) || Number(r.start) < 0 || (r.end !== undefined && (!Number.isSafeInteger(r.end) || Number(r.end) < Number(r.start) || Number(r.end) - Number(r.start) >= 8 * 1024 * 1024))) return false;
    }
    const key = `${lead}/${altitude}/${f.pressureHpa}`;
    if (seen.has(key)) return false; seen.add(key);
    hours.set(lead, (hours.get(lead) ?? 0) + 1);
  }
  return [...hours.values()].every(count => count === levels);
}
