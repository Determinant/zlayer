import { isRecord } from './validation.js';

export const AWC_ADVISORY_PRODUCTS = ['gairmet', 'sigmet', 'cwa'] as const;
export type AwcAdvisoryProduct = typeof AWC_ADVISORY_PRODUCTS[number];
export type WeatherGeometry =
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] }
  | { type: 'LineString'; coordinates: number[][] }
  | { type: 'MultiLineString'; coordinates: number[][][] };

export type WeatherAdvisory = {
  id: string;
  product: AwcAdvisoryProduct;
  identifier: string;
  hazard: string;
  /** Text qualifier from G-AIRMET; domestic SIGMET numeric codes are not equivalent. */
  severity?: string;
  issuer: string;
  issuedAt: number | null;
  validFrom: number;
  validTo: number | null;
  forecastHour: number | null;
  altitude: string;
  text: string;
  geometry: WeatherGeometry;
  /** Preserve upstream qualifiers/identifiers; map decoration never enters this record. */
  sourceProperties: Record<string, unknown>;
};
export type AwcAdvisorySnapshot = {
  schemaVersion: 1;
  product: AwcAdvisoryProduct;
  checkedAt: number;
  source: string;
  /** Explicit successful forecast frames, including those with zero advisories. */
  frameTimes: number[];
  advisories: WeatherAdvisory[];
};

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const instant = (value: unknown): value is number => finite(value) && value > 0 && value < 8.64e15;
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 100_000;
const position = (p: unknown): p is number[] => Array.isArray(p) && p.length === 2 &&
  finite(p[0]) && finite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
const line = (v: unknown): v is number[][] => Array.isArray(v) && v.length >= 2 && v.length <= 10_000 && v.every(position);
const ring = (v: unknown): v is number[][] => line(v) && v.length >= 4 &&
  v[0]![0] === v.at(-1)![0] && v[0]![1] === v.at(-1)![1];
const polygon = (v: unknown): v is number[][][] => Array.isArray(v) && v.length > 0 && v.length <= 100 && v.every(ring);

export function isWeatherGeometry(value: unknown): value is WeatherGeometry {
  if (!isRecord(value)) return false;
  if (value.type === 'LineString') return line(value.coordinates);
  if (value.type === 'Polygon') return polygon(value.coordinates);
  if (!Array.isArray(value.coordinates) || !value.coordinates.length || value.coordinates.length > 100) return false;
  return value.type === 'MultiPolygon' ? value.coordinates.every(polygon)
    : value.type === 'MultiLineString' && value.coordinates.every(line);
}

export function isWeatherAdvisory(v: unknown): v is WeatherAdvisory {
  if (!isRecord(v) || !AWC_ADVISORY_PRODUCTS.some(p => p === v.product) || !text(v.id) || !v.id ||
    !(v.severity === undefined || text(v.severity)) || !text(v.identifier) || !text(v.issuer) || !text(v.hazard) || !v.hazard || !text(v.altitude) || !text(v.text) ||
    !isRecord(v.sourceProperties) || !isWeatherGeometry(v.geometry) || !instant(v.validFrom) ||
    !(v.issuedAt === null || instant(v.issuedAt))) return false;
  return v.product === 'gairmet'
    ? v.validTo === null && [0, 3, 6, 9, 12].includes(v.forecastHour as number)
    : v.forecastHour === null && instant(v.validTo) && v.validTo > v.validFrom;
}

export function isAwcAdvisorySnapshot(v: unknown): v is AwcAdvisorySnapshot {
  if (!isRecord(v) || v.schemaVersion !== 1 || !AWC_ADVISORY_PRODUCTS.some(p => p === v.product) ||
    !instant(v.checkedAt) || !text(v.source) || !Array.isArray(v.frameTimes) || v.frameTimes.length > 5 ||
    !v.frameTimes.every(instant) || new Set(v.frameTimes).size !== v.frameTimes.length ||
    !Array.isArray(v.advisories) || v.advisories.length > 2_000 || !v.advisories.every(isWeatherAdvisory)) return false;
  const frames = v.frameTimes as number[];
  if (v.product === 'gairmet' && frames.length && (frames.length !== 5 ||
    frames.some((time, index) => time !== frames[0]! + index * 3 * 3_600_000))) return false;
  return new Set(v.advisories.map(a => a.id)).size === v.advisories.length &&
    v.advisories.every(a => a.product === v.product && (a.product !== 'gairmet' ||
      a.validFrom === frames[0]! + a.forecastHour! * 3_600_000)) &&
    (v.product === 'gairmet' || frames.length === 0);
}
