import { hasJsonReferenceIdentity, type JsonReferenceIdentity } from './json-reference.js';
export type PreferredRoutesResource = JsonReferenceIdentity & {
  id: 'preferred-routes';
  title: string;
  count: number;
  sourceCount: number;
  url: string;
};

export type PreferredRouteSegment = {
  sequence: number;
  value: string;
  type: string;
  state?: string;
  country?: string;
  icaoRegion?: string;
  navaidType?: string;
  next?: string;
};

export type PreferredRouteRecord = {
  id: string;
  originId: string;
  destinationId: string;
  routeType: string;
  routeNumber: number;
  route?: string;
  designator?: string;
  area?: string;
  altitude?: string;
  aircraft?: string;
  hours?: string;
  direction?: string;
  originCity?: string;
  originState?: string;
  originCountry?: string;
  destinationCity?: string;
  destinationState?: string;
  destinationCountry?: string;
  narType?: string;
  inlandFix?: string;
  coastalFix?: string;
  narDestination?: string;
  segments: PreferredRouteSegment[];
};

export type PreferredRoutesData = {
  type: 'ZLayerPreferredRoutes';
  metadata: { effectiveDate: string; source: string };
  routes: PreferredRouteRecord[];
};

const optionalTexts = (value: Record<string, unknown>, fields: string[]) =>
  fields.every(field => value[field] === undefined || text(value[field]));

export function isPreferredRoutesResource(value: unknown): value is PreferredRoutesResource {
  return record(value) && value.id === 'preferred-routes' && text(value.title) && text(value.url) &&
    count(value.count) && count(value.sourceCount) && value.count <= value.sourceCount &&
    hasJsonReferenceIdentity(value);
}

export function isPreferredRoutesData(value: unknown, revision?: string): value is PreferredRoutesData {
  if (!record(value) || value.type !== 'ZLayerPreferredRoutes' || !record(value.metadata)) return false;
  const date = value.metadata.effectiveDate;
  return isIsoDate(date) &&
    (revision === undefined || date === revision) && text(value.metadata.source) &&
    Array.isArray(value.routes) && value.routes.every(isPreferredRoute) &&
    new Set(value.routes.map(route => route.id)).size === value.routes.length;
}

function isPreferredRoute(value: unknown): value is PreferredRouteRecord {
  if (!record(value) || !text(value.originId) || !text(value.destinationId) || !text(value.routeType) ||
      !count(value.routeNumber) || value.routeNumber === 0 ||
      value.id !== `preferred-route:${value.originId}:${value.destinationId}:${value.routeType}:${value.routeNumber}` ||
      !optionalTexts(value, ['route', 'designator', 'area', 'altitude', 'aircraft', 'hours', 'direction',
        'originCity', 'originState', 'originCountry', 'destinationCity', 'destinationState',
        'destinationCountry', 'narType', 'inlandFix', 'coastalFix', 'narDestination']) ||
      !Array.isArray(value.segments)) return false;
  let previous = 0;
  for (const segment of value.segments) {
    if (!record(segment) || !count(segment.sequence) || segment.sequence <= previous ||
        !text(segment.value) || !text(segment.type) ||
        !optionalTexts(segment, ['state', 'country', 'icaoRegion', 'navaidType', 'next'])) return false;
    previous = segment.sequence;
  }
  return true;
}
import { isRecord as record, isNonEmptyString as text, isNonNegativeInteger as count, isIsoDate } from './validation.js';
