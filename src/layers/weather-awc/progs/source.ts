import { isRecord, type SurfaceBoundary, type SurfaceFeature, type SurfaceFrame, type SurfacePhase } from '@zlayer/contracts';
import { surfaceLineCurve } from './curves';

export const SURFACE_CATALOG = 'https://aviationweather.gov/api/data/progchart';
const HOUR = 3600_000;
export type SurfaceChart = { file: string; referenceTime: number; validTime: number; forecastHour: number; source: string };
function referenceTime(text: string): number {
  if (!/^\d{8}_\d{2}$/.test(text)) throw new Error('Invalid NOAA chart cycle');
  const iso = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T${text.slice(9)}:00:00.000Z`;
  const time = Date.parse(iso);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== iso) throw new Error('Invalid NOAA chart date');
  return time;
}
/** Only catalog-listed WPC files on the fixed AWC host can be acquired. */
export function parseSurfaceCatalog(text: string, checkedAt: number): SurfaceChart[] {
  if (text.length > 16 * 1024) throw new Error('Surface catalog exceeds its size limit');
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || !Array.isArray(value.prog) || !value.prog.length || value.prog.length > 32) throw new Error('Invalid surface catalog');
  const charts = value.prog.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.file !== 'string') throw new Error('Invalid surface catalog entry');
    const match = /^(\d{8}_\d{2})_F(\d{3})_wpc\.geojson$/.exec(entry.file);
    if (!match) throw new Error('Invalid NOAA chart filename');
    const reference = referenceTime(match[1]!), hour = Number(match[2]);
    if (entry.fhr !== hour || hour > 168 || reference > checkedAt + 60_000 || entry.vsecs !== (reference + hour * HOUR) / 1000) {
      throw new Error('NOAA chart filename and valid time disagree');
    }
    return { file: entry.file, referenceTime: reference, validTime: reference + hour * HOUR, forecastHour: hour,
      source: `https://aviationweather.gov/data/products/wpc/${entry.file.slice(0, 8)}/${entry.file}` };
  }).sort((a, b) => a.validTime - b.validTime);
  if (charts.filter(c => c.forecastHour === 0).length !== 1 || new Set(charts.map(c => c.validTime)).size !== charts.length ||
    new Set(charts.map(c => c.file)).size !== charts.length) throw new Error('Incomplete or duplicate surface catalog');
  return charts;
}
function position(value: unknown): [number, number] {
  if (!Array.isArray(value) || value.length !== 2 || !value.every(v => typeof v === 'number' && Number.isFinite(v)) ||
    Math.abs(value[0]) > 360 || Math.abs(value[1]) > 90) throw new Error('Invalid NOAA chart coordinate');
  // AWC also publishes unwrapped degrees west (e.g. −290° = 70° E).
  const longitude = value[0] as number;
  return [longitude < -180 ? longitude + 360 : longitude >= 180 ? longitude - 360 : longitude, value[1] as number];
}
function lineGeometry(coordinates: [number, number][]): Extract<SurfaceFeature, { kind: 'ISOBAR' }>['geometry'] {
  const lines: [number, number][][] = [[coordinates[0]!]];
  for (let i = 1; i < coordinates.length; i++) {
    const a = coordinates[i - 1]!, b = coordinates[i]!;
    if (Math.abs(b[0] - a[0]) > 180) {
      const longitude = b[0] > a[0] ? b[0] - 360 : b[0] + 360, edge = b[0] > a[0] ? -180 : 180;
      const latitude = a[1] + (b[1] - a[1]) * (edge - a[0]) / (longitude - a[0]);
      lines[lines.length - 1]!.push([edge, latitude]); lines.push([[-edge, latitude]]);
    }
    lines[lines.length - 1]!.push(b);
  }
  return lines.length === 1 ? { type: 'LineString', coordinates } : { type: 'MultiLineString', coordinates: lines };
}
function appendLine(features: SurfaceFeature[], feature: Extract<SurfaceFeature, { kind: 'ISOBAR' | SurfaceBoundary }>) {
  const geometry = feature.geometry;
  if (geometry.type !== 'MultiLineString' || geometry.coordinates.length <= 20) { features.push(feature); return; }
  // Global isobars can cross the date line more than twenty times. Preserve
  // every segment in bounded features accepted by existing clients.
  for (let start = 0; start < geometry.coordinates.length; start += 20) {
    features.push({ ...feature, id: `${feature.id}:${start / 20}`,
      geometry: { type: 'MultiLineString', coordinates: geometry.coordinates.slice(start, start + 20) } });
  }
}
const FRONT_CODES: Record<number, SurfaceBoundary> = {
  20: 'STNRY', 25: 'STNRY', 28: 'STNRY', 220: 'WARM', 225: 'WARM', 228: 'WARM',
  420: 'COLD', 425: 'COLD', 428: 'COLD', 620: 'OCFNT', 625: 'OCFNT', 628: 'OCFNT',
  720: 'DRYLINE', 840: 'TROF', 920: 'SQUALL', 940: 'SQUALL',
};
const CENTERS = { high: 'HIGH', low: 'LOW', 'tropical storm': 'TROPICAL_STORM', hurricane: 'HURRICANE' } as const;
/** Preserve every source record; unsupported weather symbols reject a replacement.
 * Pressure labels are independent source points, not guessed center/isobar values. */
export function parseSurfaceChart(text: string, chart: SurfaceChart, checkedAt: number, sourceHash: string): SurfaceFrame {
  if (text.length > 512 * 1024) throw new Error('NOAA chart exceeds its size limit');
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || value.type !== 'FeatureCollection' || !Array.isArray(value.features) ||
    value.features.length < 2 || value.features.length > 2501 || value.exceededTransferLimit) throw new Error('Invalid NOAA chart collection');
  let metadata = false;
  const features: SurfaceFeature[] = [];
  for (const [index, record] of value.features.entries()) {
    if (!isRecord(record) || record.type !== 'Feature' || !isRecord(record.properties)) throw new Error('Invalid NOAA chart feature');
    const p = record.properties;
    if (p.type === 'fronts') {
      if (metadata || p.datim !== chart.file.slice(0, 11) || p.fhr !== chart.forecastHour || record.geometry != null) throw new Error('NOAA chart metadata does not match its catalog');
      metadata = true; continue;
    }
    if (!isRecord(record.geometry)) throw new Error('Missing NOAA chart geometry');
    const common = { id: `${sourceHash}:${index}`, sourceProperties: { ...p } as Record<string, string | number> };
    const g = record.geometry;
    if (p.type === 1 || p.type === 2) {
      if (g.type !== 'LineString' || !Array.isArray(g.coordinates) || g.coordinates.length < 2 || g.coordinates.length > 5000) throw new Error('Invalid NOAA chart line');
      const controls = g.coordinates.map(position);
      const coordinates = surfaceLineCurve(controls);
      if (p.type === 1) appendLine(features, { ...common, kind: 'ISOBAR', geometry: lineGeometry(coordinates) });
      else {
        const kind = typeof p.fcode === 'number' ? FRONT_CODES[p.fcode] : undefined;
        if (!kind || ![1, 2].includes(p.fpipdr as number) || typeof p.front !== 'string') throw new Error(`Unsupported NOAA front: ${p.fcode}`);
        if (p.fpipdr === 2) coordinates.reverse();
        const phase: SurfacePhase = Number(p.fcode) % 10 === 5 ? 'forming' : Number(p.fcode) % 10 === 8 ? 'weakening' : 'normal';
        appendLine(features, { ...common, kind, phase, geometry: lineGeometry(coordinates) });
      }
    } else if (p.type === 15 || p.type === 21) {
      if (g.type !== 'Point') throw new Error('Invalid NOAA chart point');
      const geometry = { type: 'Point' as const, coordinates: position(g.coordinates) };
      if (p.type === 21 && typeof p.text === 'string' && p.text.trim()) {
        const label = p.text.replace(/\$/g, '\n').trim();
        if (!label) throw new Error('Empty NOAA chart label');
        features.push({ ...common, kind: 'LABEL', text: label, geometry });
      } else if (p.type === 15 && typeof p.code === 'string' && Object.hasOwn(CENTERS, p.code)) {
        features.push({ ...common, kind: CENTERS[p.code as keyof typeof CENTERS], geometry });
      } else throw new Error(`Unsupported NOAA point: ${p.code ?? p.text}`);
    } else throw new Error(`Unsupported NOAA chart feature: ${p.type}`);
  }
  if (!metadata || !features.some(f => f.kind === 'ISOBAR')) throw new Error('Incomplete NOAA pressure chart');
  return { validTime: chart.validTime, referenceTime: chart.referenceTime, checkedAt, source: chart.source, sourceHash, sourceDocument: text, features };
}
