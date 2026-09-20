import type { Bounds } from './types.js';

export function isPointGeometry(value: unknown): boolean {
  if (!isRecord(value) || value.type !== 'Point' || !Array.isArray(value.coordinates)) {
    return false;
  }
  if (value.coordinates.length !== 2) return false;
  const [longitude, latitude] = value.coordinates;
  return typeof longitude === 'number' &&
    Number.isFinite(longitude) &&
    longitude >= -180 &&
    longitude <= 180 &&
    typeof latitude === 'number' &&
    Number.isFinite(latitude) &&
    latitude >= -90 &&
    latitude <= 90;
}

export function isBounds(value: unknown): value is Bounds {
  if (!Array.isArray(value) || value.length !== 4) return false;
  const [west, south, east, north] = value;
  return typeof west === 'number' &&
    Number.isFinite(west) &&
    west >= -180 &&
    west <= 180 &&
    typeof east === 'number' &&
    Number.isFinite(east) &&
    east >= -180 &&
    east <= 180 &&
    typeof south === 'number' &&
    Number.isFinite(south) &&
    south >= -90 &&
    south <= 90 &&
    typeof north === 'number' &&
    Number.isFinite(north) &&
    north >= -90 &&
    north <= 90 &&
    south <= north;
}

/** Package rectangles cannot wrap the antimeridian; legacy chart bounds can. */
export function isStrictBounds(value: unknown): value is Bounds {
  return isBounds(value) && value[0] < value[2] && value[1] < value[3];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

export function isCycle(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}$/.test(value);
}

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

export function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
}

export function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

export function isOptionalNullableString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

export function isOptionalNullableNumber(value: unknown): boolean {
  return value === undefined || value === null ||
    (typeof value === 'number' && Number.isFinite(value));
}

export function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

export function isOptionalNullableStringOrNumber(value: unknown): boolean {
  return isOptionalNullableString(value) ||
    (typeof value === 'number' && Number.isFinite(value));
}

export function isOptionalObservationTime(value: unknown): boolean {
  return value === undefined ||
    (typeof value === 'string' && Number.isFinite(Date.parse(value))) ||
    (typeof value === 'number' && Number.isFinite(value));
}

export function hasValidDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const epoch = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(epoch) && new Date(epoch).toISOString().slice(0, 10) === value;
}

export function hasUniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}
