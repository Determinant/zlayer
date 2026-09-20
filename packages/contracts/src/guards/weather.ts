import type { MetarFeature, MetarFeatureCollection } from '../types.js';
import { isPointGeometry, isRecord, isOptionalString, isOptionalNullableString, isOptionalNullableNumber, isOptionalNullableStringOrNumber, isOptionalObservationTime } from '../validation.js';

export function isMetarFeatureCollection(value: unknown): value is MetarFeatureCollection {
  return isRecord(value) &&
    value.type === 'FeatureCollection' &&
    Array.isArray(value.features) &&
    value.features.every(isMetarFeature);
}

export function isMetarFeature(value: unknown): value is MetarFeature {
  return isRecord(value) &&
    value.type === 'Feature' &&
    isPointGeometry(value.geometry) &&
    isMetarProperties(value.properties);
}

export function isMetarProperties(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return isOptionalString(value.id) &&
    isOptionalString(value.icaoId) &&
    isOptionalString(value.site) &&
    isOptionalObservationTime(value.obsTime) &&
    isOptionalNullableString(value.fltcat) &&
    isOptionalNullableString(value.fltCat) &&
    isOptionalNullableStringOrNumber(value.visib) &&
    isOptionalNullableNumber(value.ceil) &&
    isOptionalNullableString(value.cover) &&
    (value.clouds === undefined || (
      Array.isArray(value.clouds) && value.clouds.every(isMetarCloud)
    )) &&
    isOptionalNullableStringOrNumber(value.wdir) &&
    isOptionalNullableNumber(value.wspd) &&
    isOptionalNullableNumber(value.wgst) &&
    isOptionalString(value.rawOb);
}

export function isMetarCloud(value: unknown): boolean {
  return isRecord(value) &&
    isOptionalNullableString(value.cover) &&
    isOptionalNullableNumber(value.base);
}
