import { isRouteHistoryData, isRouteHistoryResource, type RouteHistoryResource } from '@zlayer/contracts';
import { jsonIdentity } from './json-identity';
import { isTerminalProceduresData, isTerminalProceduresResource,
  type TerminalProceduresData, type TerminalProceduresResource } from '@zlayer/contracts';
import {
  isAirwayDataResponse, isAirwayResourceRecord, isChartSupplementCatalog, isGeoPointFeature,
  isNavigationLayerRecord, isPreferredRoutesData, isPreferredRoutesResource, isProcedureCatalog,
  isProcedureResourceRecord, isRecord,
  type AirwayDataResponse, type AirwayResourceRecord, type GeoPointFeature, type NavigationLayerRecord,
  type PreferredRoutesData, type PreferredRoutesResource, type ProcedureCatalog, type ProcedureResourceRecord, type ChartSupplementCatalog,
} from '@zlayer/contracts';

/** Persist the same resource expectations used by ordinary product loaders. */
export type ReferenceResource = NavigationLayerRecord | AirwayResourceRecord |
  PreferredRoutesResource | RouteHistoryResource | TerminalProceduresResource | ProcedureResourceRecord |
  { id: 'chart-supplements'; url: string; snapshot?: ChartSupplementCatalog } |
  { id: 'unverified'; url: string };

export type SourceFeatureCollection = {
  type: 'FeatureCollection';
  metadata: { effectiveDate: string; source: string };
  features: GeoPointFeature[];
};

export function navigationDocumentGuard(resource: NavigationLayerRecord, revision: string) {
  return (value: unknown): value is SourceFeatureCollection => isRecord(value) &&
    value.type === 'FeatureCollection' && isRecord(value.metadata) &&
    value.metadata.effectiveDate === revision && typeof value.metadata.source === 'string' &&
    value.metadata.source.length > 0 && Array.isArray(value.features) &&
    value.features.length === resource.sourceCount && value.features.every(isGeoPointFeature) &&
    matchesJsonIdentity(resource, value);
}

export function airwayDocumentGuard(resource: AirwayResourceRecord, revision: string) {
  return (value: unknown): value is AirwayDataResponse =>
    isAirwayDataResponse(value, revision) && value.airways.length === resource.count && matchesJsonIdentity(resource, value);
}

export function preferredRoutesDocumentGuard(resource: PreferredRoutesResource, revision: string) {
  return (value: unknown): value is PreferredRoutesData =>
    isPreferredRoutesData(value, revision) && value.routes.length === resource.count && matchesJsonIdentity(resource, value);
}

export function terminalProceduresDocumentGuard(resource: TerminalProceduresResource, revision: string) {
  return (value: unknown): value is TerminalProceduresData =>
    isTerminalProceduresData(value, revision) && value.procedures.length === resource.count &&
    (resource.schemaVersion === undefined || value.metadata.schemaVersion === resource.schemaVersion &&
      value.coverage !== undefined && resource.coverage !== undefined &&
      jsonIdentity(value.coverage) === jsonIdentity(resource.coverage)) && matchesJsonIdentity(resource, value);
}

export function procedureCatalogGuard(resource: ProcedureResourceRecord) {
  // Preserve legacy timestamp expectations; new resources also carry a publisher digest.
  const version = new URL(resource.url, 'https://reference.invalid/').searchParams.get('v');
  return (value: unknown): value is ProcedureCatalog => isProcedureCatalog(value, resource.effectiveDate) &&
    (resource.associationStatus === undefined || (resource.associationStatus === 'available') === (value.associations !== undefined)) &&
    (version === null || value.generatedAt === version) &&
    value.cycle === resource.cycle && value.expirationDate === resource.expirationDate &&
    value.airports.length === resource.airportCount &&
    value.airports.reduce((total, airport) => total + airport.procedures.length, 0) === resource.procedureCount &&
    matchesJsonIdentity(resource, value);
}

export function referenceGuard(resource: ReferenceResource, revision: string): (value: unknown) => value is object {
  switch (resource.id) {
    case 'airways': return airwayDocumentGuard(resource, revision);
    case 'preferred-routes': return preferredRoutesDocumentGuard(resource, revision);
    case 'terminal-procedures': return terminalProceduresDocumentGuard(resource, revision);
    case 'route-history': return routeHistoryDocumentGuard(resource, revision);
    case 'procedures': return (value): value is object =>
      resource.effectiveDate === revision && procedureCatalogGuard(resource)(value);
    case 'chart-supplements': return (value) => isChartSupplementCatalog(value, revision);
    case 'unverified': return (_value): _value is object => false;
    default: return navigationDocumentGuard(resource, revision);
  }
}

export function isReferenceResource(value: unknown): value is ReferenceResource {
  return isNavigationLayerRecord(value) || isAirwayResourceRecord(value) ||
    isPreferredRoutesResource(value) || isRouteHistoryResource(value) || isTerminalProceduresResource(value) || isProcedureResourceRecord(value) ||
    (isRecord(value) && (value.id === 'chart-supplements' || value.id === 'unverified') &&
      typeof value.url === 'string' && value.url.length > 0 &&
      (value.snapshot === undefined || (value.id === 'chart-supplements' && isChartSupplementCatalog(value.snapshot))));
}

export function matchesJsonIdentity(resource: { jsonSha256?: string }, value: object): boolean {
  return resource.jsonSha256 === undefined || jsonIdentity(value) === resource.jsonSha256;
}

export function routeHistoryDocumentGuard(resource: RouteHistoryResource, revision: string) {
  return (value: unknown): value is import('@zlayer/contracts').RouteHistoryData =>
    isRouteHistoryData(value, revision, resource) && matchesJsonIdentity(resource, value);
}
