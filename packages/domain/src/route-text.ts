import type { GeoPointFeature } from '@zlayer/contracts';
import { featureIdentifiers } from './features.js';

export const ROUTE_DELIMITER = /[\s.,>\-/]/;

export function routeTokensFromText(input: string): string[] {
  return input
    .split(ROUTE_DELIMITER)
    .map(normalizeRouteToken)
    .filter(token => !!token && token !== 'DCT' && token !== 'DIRECT');
}

export function normalizeRouteToken(value: string): string {
  return value.trim().toUpperCase();
}

export function routeTokenForFeature(feature: GeoPointFeature): string {
  // A display name is not a route identifier: it can create several tokens and
  // displace every pin after a map edit. Skip blank aliases before trying the next.
  for (const token of featureIdentifiers(feature)) {
    if (!ROUTE_DELIMITER.test(token) && token !== 'DCT' && token !== 'DIRECT') return token;
  }
  return '';
}
