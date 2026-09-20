import { hasJsonReferenceIdentity, type JsonReferenceIdentity } from './json-reference.js';
import { isRecord, isNonEmptyString as text, isIsoDate, isSha256, hasValidDate } from './validation.js';

export type ObservationRange = { firstSeen: string; lastSeen: string };
export type RouteHistorySource = {
  name: string; url: string; downloadUrl: string; sha256: string;
  etag?: string; lastModified?: string; filename?: string;
};
export type RouteHistoryResource = JsonReferenceIdentity & {
  id: 'route-history'; title: string; url: string; compression: 'gzip';
  count: number; routeCount: number; bytes: number; uncompressedBytes: number;
  source: RouteHistorySource; observationRange: ObservationRange;
};
export type RouteFrequency = ObservationRange & {
  route: string; count: number; engineCounts: Record<string, number>;
};
export type RouteHistoryPair = {
  origin: string; destination: string; totalCount: number; routes: RouteFrequency[];
};
export type RouteHistoryData = {
  type: 'ZLayerRouteHistory'; version: 1; effectiveDate: string;
  source: RouteHistorySource; countBasis: 'source-filed-route-use-count';
  observationRange: ObservationRange; pairs: RouteHistoryPair[];
};

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const range = <T>(value: T): value is T & ObservationRange => isRecord(value) &&
  isIsoDate(value.firstSeen) && isIsoDate(value.lastSeen) && value.firstSeen <= value.lastSeen;
const webUrl = (value: unknown): value is string => {
  if (!text(value)) return false;
  try { return ['https:', 'http:'].includes(new URL(value).protocol); } catch { return false; }
};
function source(value: unknown): value is RouteHistorySource {
  return isRecord(value) && text(value.name) && webUrl(value.url) && webUrl(value.downloadUrl) &&
    isSha256(value.sha256) && (value.etag === undefined || text(value.etag)) &&
    (value.filename === undefined || text(value.filename)) &&
    (value.lastModified === undefined || (text(value.lastModified) && hasValidDate(value.lastModified)));
}

export function isRouteHistoryResource(value: unknown): value is RouteHistoryResource {
  return isRecord(value) && value.id === 'route-history' && text(value.title) && text(value.url) &&
    value.compression === 'gzip' && [value.count, value.routeCount, value.bytes, value.uncompressedBytes].every(positive) &&
    source(value.source) && range(value.observationRange) &&
    hasJsonReferenceIdentity(value);
}

/** Match the published manifest and validate totals before frequencies can enter recommendations. */
export function isRouteHistoryData(value: unknown, revision: string, resource: RouteHistoryResource): value is RouteHistoryData {
  if (!isRecord(value) || value.type !== 'ZLayerRouteHistory' || value.version !== 1 ||
      value.effectiveDate !== revision || value.countBasis !== 'source-filed-route-use-count' ||
      !source(value.source) || value.source.sha256 !== resource.source.sha256 || !range(value.observationRange) ||
      value.observationRange.firstSeen !== resource.observationRange.firstSeen ||
      value.observationRange.lastSeen !== resource.observationRange.lastSeen ||
      !Array.isArray(value.pairs) || value.pairs.length !== resource.count) return false;
  const pairs = new Set<string>();
  let routeCount = 0;
  for (const pair of value.pairs) {
    if (!isRecord(pair) || !text(pair.origin) || !text(pair.destination) || !positive(pair.totalCount) ||
        !Array.isArray(pair.routes) || pair.routes.length === 0) return false;
    const key = JSON.stringify([pair.origin, pair.destination]);
    if (pairs.has(key)) return false;
    pairs.add(key);
    const routes = new Set<string>();
    let total = 0;
    for (const route of pair.routes) {
      if (!isRecord(route) || !text(route.route) || routes.has(route.route) || !positive(route.count) ||
          !range(route) || route.firstSeen < value.observationRange.firstSeen || route.lastSeen > value.observationRange.lastSeen ||
          !isRecord(route.engineCounts)) return false;
      const engines = Object.entries(route.engineCounts);
      if (engines.length === 0 || !engines.every(([name, count]) => text(name) && positive(count)) ||
          engines.reduce((sum, [, count]) => sum + Number(count), 0) !== route.count) return false;
      routes.add(route.route);
      total += route.count;
      routeCount++;
    }
    if (total !== pair.totalCount) return false;
  }
  return routeCount === resource.routeCount;
}
