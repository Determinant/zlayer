import { GRID_BELOW_GROUND, GRID_MISSING, GRID_OUTSIDE, GRID_UNKNOWN, type AwcGridField } from '@zlayer/contracts';
import type { GridProductState } from './client';
import type { GridState } from './controller';
import type { ForecastManifest } from './native-source';
import type { DecodedGrid } from './format';

/** Share displayed metadata only for the same provider, model cycle and valid time.
 * Surface/pressure files and source-check times may differ within that forecast. */
export function pointForecastGroups(data: readonly DecodedGrid[]): DecodedGrid[][] {
  const groups = new Map<string, DecodedGrid[]>();
  for (const forecast of data) {
    const { manifest, frame, endpoint } = forecast;
    const providers = [...new Set(frame.sources.map(source => new URL(source).origin))].sort();
    const key = JSON.stringify([endpoint, providers, manifest.model, manifest.runTime, frame.validTime]);
    const group = groups.get(key);
    if (group) group.push(forecast); else groups.set(key, [forecast]);
  }
  return [...groups.values()];
}

export function forecastIsStale(record: GridProductState | undefined, manifest: ForecastManifest | undefined, now: number, offline: boolean): boolean {
  return offline || !record?.checkedAt || !!record.error || !manifest || now < record.checkedAt || now < manifest.checkedAt ||
    now - record.checkedAt > 10 * 60_000 || now - manifest.checkedAt > 90 * 60_000 || now - manifest.runTime > 3 * 3600000;
}

export function preparationLabel(preparation: NonNullable<GridState['preparation']>): string {
  if (!preparation.total) return preparation.limited ? 'Offline save incomplete' : 'Checking forecast times…';
  return `${preparation.limited ? 'Offline save incomplete' : preparation.ready === preparation.total ? 'Forecasts saved' : 'Saving forecasts'} · ${preparation.ready}/${preparation.total}`;
}

export const GRID_LABELS: Record<AwcGridField, string> = {
  cloudCover: 'Cloud coverage', cloudBase: 'Cloud bases', cloudTop: 'Cloud tops',
  freezingLowest: 'Lowest freezing height', freezingHighest: 'Highest freezing height',
  icingProbability: 'Icing probability', icingSeverity: 'Icing severity', sldPotential: 'SLD potential',
  windHeight: 'Forecast height', windEast: 'Eastward wind', windNorth: 'Northward wind', temperature: 'Temperature aloft',
};
export const SEVERITY = ['None', 'Trace', 'Light', 'Moderate', 'Severe'];
type Bin = { max: number; color: string; label: string };
const HEIGHTS: Bin[] = [
  { max: 1000, color: '#b81876', label: '<1k' }, { max: 3000, color: '#8a2ba8', label: '1–3k' },
  { max: 6000, color: '#4f49b4', label: '3–6k' }, { max: 10000, color: '#1168b3', label: '6–10k' },
  { max: 18000, color: '#008377', label: '10–18k' }, { max: Infinity, color: '#596f28', label: '≥18k ft' },
];
const PERCENT: Bin[] = [
  { max: 10, color: '#d5e2ef', label: '<10%' }, { max: 25, color: '#89bce0', label: '10–25' },
  { max: 50, color: '#4698cc', label: '25–50' }, { max: 75, color: '#2366a8', label: '50–75' },
  { max: Infinity, color: '#3b3389', label: '≥75%' },
];
const ICE: Bin[] = ['#dde6ea', '#8cbad0', '#2d8ab5', '#7652ae', '#bd2464'].map((color, i) => ({ max: i + 1, color, label: SEVERITY[i]! }));
const SLD: Bin[] = [
  { max: 0, color: '#00000000', label: '0 (clear)' }, { max: 0.25, color: '#be7d40', label: '>0–<0.25' },
  { max: 0.5, color: '#bf4c24', label: '0.25–<0.5' }, { max: Infinity, color: '#a61c4c', label: '≥0.5' },
];
const TEMPERATURE: Bin[] = [
  { max: -40, color: '#603ca0', label: '<−40°C' }, { max: -20, color: '#3668b0', label: '−40–−20' },
  { max: 0, color: '#359fae', label: '−20–0' }, { max: 20, color: '#dfa84c', label: '0–20' },
  { max: Infinity, color: '#bd4439', label: '≥20°C' },
];
export function gridLegend(field: AwcGridField): readonly Bin[] {
  return field === 'temperature' ? TEMPERATURE : field === 'icingSeverity' ? ICE : field === 'sldPotential' ? SLD : field === 'cloudCover' || field === 'icingProbability' ? PERCENT : HEIGHTS;
}
export function gridDescription(field: AwcGridField): string {
  return field === 'temperature' ? 'HRRR temperature · °C at the selected wind altitude'
    : field === 'cloudCover' ? 'HRRR total cloud cover · full atmospheric column'
    : field === 'cloudBase' ? 'Lowest diagnosed cloud base, ft MSL · not a ceiling'
    : field === 'cloudTop' ? 'Highest diagnosed cloud top, ft MSL'
    : field === 'freezingLowest' ? 'Lowest 0°C diagnostic, ft MSL · may equal the surface'
    : field === 'freezingHighest' ? 'Highest tropospheric 0°C diagnostic, ft MSL'
    : field === 'sldPotential' ? 'IFI SLD potential index 0–1 · not a probability'
    : 'IFI at the selected altitude · ft MSL';
}
export function gridValueLabel(field: AwcGridField, value: number): string {
  if (value === GRID_BELOW_GROUND) return 'Below model terrain';
  if (value === GRID_OUTSIDE) return 'Outside model coverage';
  if (value === GRID_UNKNOWN) return field === 'sldPotential' ? 'SLD undetermined' : 'Unknown source value';
  if (value === GRID_MISSING) return field === 'cloudBase' ? 'No cloud base diagnosed'
    : field === 'cloudTop' ? 'No cloud top diagnosed' : 'Not available';
  if (field === 'icingSeverity') return SEVERITY[value] ?? 'Unknown';
  if (field === 'sldPotential') return value === 0 ? 'No SLD forecast (0.00)' : value.toFixed(2);
  if (field === 'temperature') return `${value.toFixed(1)}°C`;
  if (field === 'windEast' || field === 'windNorth') return `${value.toFixed(1)} kt`;
  if (field === 'cloudCover' || field === 'icingProbability') return `${Math.round(value)}%`;
  return `${Math.round(value).toLocaleString('en-US')} ft MSL`;
}

/** Precompute colors and field rules once; the pixel loop never allocates. */
function colorizer<T>(field: AwcGridField, pack: (r: number, g: number, b: number, a: number) => T) {
  const bins = gridLegend(field), colors = bins.map(bin => pack(
    parseInt(bin.color.slice(1, 3), 16), parseInt(bin.color.slice(3, 5), 16), parseInt(bin.color.slice(5, 7), 16), 255));
  const clear = pack(0, 0, 0, 0), hatch = pack(177, 16, 36, 215);
  const clearZero = field === 'cloudCover' || field === 'icingProbability' || field === 'icingSeverity' || field === 'sldPotential';
  return (value: number, x: number, y: number, sld: number | undefined): T => {
    // Absent diagnostics and unavailable cells stay unshaded; point details distinguish them.
    if (value === GRID_OUTSIDE || value === GRID_BELOW_GROUND || value === GRID_MISSING || value === GRID_UNKNOWN) return clear;
    if (sld !== undefined && sld > 0 && (x + y) % 7 < 2) return hatch;
    if (value === 0 && clearZero) return clear;
    // Thresholds are lower inclusive.
    for (let i = 0; i < bins.length; i++) if (value < bins[i]!.max) return colors[i]!;
    return colors[colors.length - 1]!;
  };
}

export const gridColorizer = (field: AwcGridField) => colorizer(field, (r, g, b, a): readonly number[] => [r, g, b, a]);

/** Native word order makes a Uint32 write produce RGBA bytes on either endian host. */
export function gridPackedColorizer(field: AwcGridField) {
  const bytes = new Uint8Array(4), word = new Uint32Array(bytes.buffer);
  return colorizer(field, (r, g, b, a) => {
    bytes[0] = r; bytes[1] = g; bytes[2] = b; bytes[3] = a;
    return word[0]!;
  });
}
