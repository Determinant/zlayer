import { isRouteHistoryResource } from '../route-history.js';
import type { CatalogResponse, ChartKind, ChartRecord, ProductStatus, WeatherProductRecord } from '../types.js';
import { isNavigationLayerRecord, isAirwayResourceRecord } from './navigation.js';
import { isTerminalProceduresResource } from '../terminal-procedures.js';
import { isProcedureResourceRecord } from './procedures.js';
import { isBounds, isRecord, isNonEmptyString, isNonNegativeInteger, isSha256, hasValidDate, hasUniqueStrings } from '../validation.js';
import { isChartPackageIndex } from '../chart-packages.js';
import { isPreferredRoutesResource } from '../preferred-routes.js';

export function isCatalogResponse(value: unknown): value is CatalogResponse {
  if (!isRecord(value)) return false;
  return value.schemaVersion === 1 &&
    isNonEmptyString(value.generatedAt) &&
    hasValidDate(value.generatedAt) &&
    isNonEmptyString(value.revision) &&
    Array.isArray(value.charts) &&
    value.charts.every(isChartRecord) &&
    value.charts.every((chart) => chart.revision === value.revision) &&
    hasUniqueStrings(value.charts.map((chart) => chart.id)) &&
    (value.chartPackages === undefined || (isRecord(value.chartPackages) &&
      isNonEmptyString(value.chartPackages.root) && isChartPackageIndex(value.chartPackages))) &&
    Array.isArray(value.navigation) &&
    value.navigation.every(isNavigationLayerRecord) &&
    hasUniqueStrings(value.navigation.map((layer) => layer.id)) &&
    (value.airways === undefined || isAirwayResourceRecord(value.airways)) &&
    (value.terminalProcedures === undefined || isTerminalProceduresResource(value.terminalProcedures)) &&
    (value.preferredRoutes === undefined || isPreferredRoutesResource(value.preferredRoutes)) &&
    (value.routeHistory === undefined || isRouteHistoryResource(value.routeHistory)) &&
    (value.procedures === undefined || (
      isProcedureResourceRecord(value.procedures) &&
      value.procedures.effectiveDate === value.revision
    )) &&
    Array.isArray(value.weather) &&
    value.weather.every(isWeatherProductRecord) &&
    hasUniqueStrings(value.weather.map((product) => product.id));
}

export function isChartRecord(value: unknown): value is ChartRecord {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.id) &&
    isNonEmptyString(value.title) &&
    typeof value.kind === 'string' &&
    CHART_KINDS.has(value.kind as ChartKind) &&
    isNonEmptyString(value.revision) &&
    value.format === 'mbtiles' &&
    isBounds(value.bounds) &&
    isNonNegativeInteger(value.minZoom) &&
    isNonNegativeInteger(value.maxZoom) &&
    value.maxZoom <= 24 &&
    value.minZoom <= value.maxZoom &&
    isNonNegativeInteger(value.byteLength) &&
    value.byteLength > 0 &&
    isSha256(value.sha256) &&
    isNonEmptyString(value.url);
}

export function isWeatherProductRecord(value: unknown): value is WeatherProductRecord {
  return isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.title) &&
    typeof value.status === 'string' &&
    PRODUCT_STATUSES.has(value.status as ProductStatus);
}

const CHART_KINDS = new Set<ChartKind>([
  'vfr-sectional',
  'vfr-terminal',
  'vfr-flyway',
  'ifr-low',
  'unknown',
]);

const PRODUCT_STATUSES = new Set<ProductStatus>([
  'current',
  'stale',
  'unavailable',
  'planned',
]);
