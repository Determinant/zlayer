import { hasJsonReferenceIdentity } from '../json-reference.js';
import type { AirwayDataResponse, AirwayRecord, AirwayResourceRecord, AirwaySegment, FeatureCollectionResponse, GeoPointFeature, NavigationLayerId, NavigationLayerRecord } from '../types.js';
import { isPointGeometry, isRecord, isNonEmptyString, isNonNegativeInteger, isOptionalString, isOptionalNullableNumber, isOptionalFiniteNumber, isOptionalNullableStringOrNumber, hasValidDate, isIsoDate, hasUniqueStrings } from '../validation.js';

export function isAirwayDataResponse(
  value: unknown,
  expectedRevision?: string,
): value is AirwayDataResponse {
  if (!isRecord(value) || value.type !== 'ZLayerAirways' || !isRecord(value.metadata)) {
    return false;
  }
  return isIsoDate(value.metadata.effectiveDate) &&
    (expectedRevision === undefined || value.metadata.effectiveDate === expectedRevision) &&
    isNonEmptyString(value.metadata.source) &&
    Array.isArray(value.airways) &&
    value.airways.every(isAirwayRecord) &&
    hasUniqueStrings(value.airways.map((airway) => airway.id));
}

export function isFeatureCollectionResponse(
  value: unknown,
  expectedLayer?: NavigationLayerId,
  expectedRevision?: string,
): value is FeatureCollectionResponse {
  if (!isRecord(value) || value.type !== 'FeatureCollection' || !Array.isArray(value.features)) {
    return false;
  }
  if (!value.features.every(isGeoPointFeature) || !isRecord(value.meta)) return false;
  const layer = value.meta.layer;
  return isNonEmptyString(value.meta.revision) &&
    (expectedRevision === undefined || value.meta.revision === expectedRevision) &&
    isNavigationLayerId(layer) &&
    (expectedLayer === undefined || layer === expectedLayer) &&
    isNonNegativeInteger(value.meta.returned) &&
    value.meta.returned === value.features.length &&
    typeof value.meta.truncated === 'boolean';
}

export function isNavigationLayerRecord(value: unknown): value is NavigationLayerRecord {
  if (!isRecord(value)) return false;
  return isNavigationLayerId(value.id) &&
    isNonEmptyString(value.title) &&
    isNonNegativeInteger(value.count) &&
    isNonNegativeInteger(value.sourceCount) &&
    value.count <= value.sourceCount &&
    isNonNegativeInteger(value.minZoom) &&
    isNonEmptyString(value.url) && hasJsonReferenceIdentity(value);
}

export function isAirwayResourceRecord(value: unknown): value is AirwayResourceRecord {
  return isRecord(value) &&
    value.id === 'airways' &&
    isNonEmptyString(value.title) &&
    isNonNegativeInteger(value.count) &&
    isNonNegativeInteger(value.sourceCount) &&
    value.count <= value.sourceCount &&
    isNonEmptyString(value.url) && hasJsonReferenceIdentity(value);
}

export function isAirwayRecord(value: unknown): value is AirwayRecord {
  return isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.ident) &&
    isOptionalString(value.location) &&
    (value.regulatory === undefined || typeof value.regulatory === 'boolean') &&
    isOptionalString(value.updatedAt) &&
    (value.updatedAt === undefined || (
      typeof value.updatedAt === 'string' && hasValidDate(value.updatedAt)
    )) &&
    Array.isArray(value.points) &&
    value.points.length >= 2 &&
    value.points.every(isNonEmptyString) &&
    isOptionalString(value.remark) &&
    Array.isArray(value.segments) &&
    value.segments.every(isAirwaySegment);
}

export function isAirwaySegment(value: unknown): value is AirwaySegment {
  if (!isRecord(value)) return false;
  return isNonNegativeInteger(value.sequence) &&
    isNonEmptyString(value.from) &&
    typeof value.gap === 'boolean' &&
    isOptionalString(value.fromType) &&
    isOptionalString(value.to) &&
    [
      value.magneticCourse,
      value.oppositeMagneticCourse,
      value.distanceNm,
      value.meaFt,
      value.oppositeMeaFt,
      value.gpsMeaFt,
      value.mocaFt,
      value.maxAuthorizedAltitudeFt,
    ].every(isOptionalFiniteNumber) &&
    [
      value.state,
      value.country,
      value.icaoRegion,
      value.artcc,
      value.remark,
    ].every(isOptionalString);
}

export function isGeoPointFeature(value: unknown): value is GeoPointFeature {
  return isRecord(value) &&
    value.type === 'Feature' &&
    (value.id === undefined || typeof value.id === 'string') &&
    isPointGeometry(value.geometry) &&
    isGeoPointProperties(value.properties);
}

export function isGeoPointProperties(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return [
    value.kind,
    value.ident,
    value.faaId,
    value.icaoId,
    value.name,
    value.city,
    value.state,
    value.type,
    value.facilityType,
    value.use,
    value.frequency,
    value.lowArtcc,
    value.metarStationId,
    value.metarObservedAt,
    value.rawMetar,
    value.weatherSource,
  ].every(isOptionalString) &&
    (value.stationDeclinationDeg === undefined || (typeof value.stationDeclinationDeg === 'number' &&
      Number.isFinite(value.stationDeclinationDeg) && Math.abs(value.stationDeclinationDeg) <= 180)) &&
    (value.towered === undefined || typeof value.towered === 'boolean') &&
    (value.runways === undefined || (Array.isArray(value.runways) && value.runways.every(isAirportRunway))) &&
    (value.frequencies === undefined || (Array.isArray(value.frequencies) && value.frequencies.every(isAirportFrequency))) &&
    [
      value.elevationFt,
      value.longestRunwayFt,
      value.metarCeilingFt,
      value.metarVisibilitySm,
      value.metarWindSpeedKt,
      value.metarWindGustKt,
    ].every(isOptionalNullableNumber) &&
    isOptionalNullableStringOrNumber(value.metarWindDirection) &&
    (value.metarCeilingStatus === undefined || (typeof value.metarCeilingStatus === 'string' &&
      ['measured', 'none', 'unknown'].includes(value.metarCeilingStatus))) &&
    (value.flightCategory === undefined || (
      typeof value.flightCategory === 'string' && FLIGHT_CATEGORIES.has(value.flightCategory)
    )) &&
    (value.displayFlightCategory === undefined || (
      typeof value.displayFlightCategory === 'string' &&
      DISPLAY_FLIGHT_CATEGORIES.has(value.displayFlightCategory)
    ));
}

export function isAirportRunway(value: unknown): boolean {
  return isRecord(value) && isNonEmptyString(value.id) &&
    [value.lengthFt, value.widthFt].every(number => number === undefined ||
      (typeof number === 'number' && Number.isFinite(number) && number >= 0)) &&
    [value.surface, value.condition, value.lighting].every(isOptionalString) &&
    (value.ends === undefined || (Array.isArray(value.ends) && value.ends.every(end =>
      isRecord(end) && isNonEmptyString(end.id) &&
      (end.trueHeadingDeg === undefined || (typeof end.trueHeadingDeg === 'number' &&
        Number.isFinite(end.trueHeadingDeg) && end.trueHeadingDeg >= 0 && end.trueHeadingDeg <= 360)) &&
      (end.trafficPattern === undefined || end.trafficPattern === 'left' || end.trafficPattern === 'right')
    )));
}

export function isAirportFrequency(value: unknown): boolean {
  return isRecord(value) && typeof value.type === 'string' &&
    ['ATIS', 'D-ATIS', 'AWOS', 'ASOS', 'TOWER', 'CTAF', 'GROUND'].includes(value.type) &&
    typeof value.frequencyMHz === 'number' && Number.isFinite(value.frequencyMHz) &&
    value.frequencyMHz >= 100 && value.frequencyMHz < 400 &&
    [value.use, value.sector, value.hours, value.remarks].every(isOptionalString);
}

export function isNavigationLayerId(value: unknown): value is NavigationLayerId {
  return typeof value === 'string' && NAVIGATION_LAYER_IDS.has(value as NavigationLayerId);
}

const NAVIGATION_LAYER_IDS = new Set<NavigationLayerId>([
  'airports',
  'vfr-waypoints',
  'navaids',
  'fixes',
]);

const FLIGHT_CATEGORIES = new Set(['VFR', 'MVFR', 'IFR', 'LIFR']);

const DISPLAY_FLIGHT_CATEGORIES = new Set([...FLIGHT_CATEGORIES, 'N/A']);
