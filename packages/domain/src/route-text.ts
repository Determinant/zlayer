import type { GeoPointFeature } from '@zlayer/contracts';
import { featureIdentifiers } from './features.js';
import { normalizeRouteCoordinate } from './route-coordinate.js';
import { parseRadialDefinition, radialDefinitionText } from './radial-position.js';

export const ROUTE_DELIMITER = /[\s.,>\-/]/;

// A latitude/longitude slash belongs to the coordinate, including an unfinished
// longitude while typing. Other slashes remain ordinary route separators.
const ROUTE_PARTS = /\d{4}(?:\d{2})?[NS]\/\d*[EW]?(?=$|[\s.,>\-/])|(?=[A-Z0-9]{0,7}[A-Z])[A-Z0-9]{2,8}\/\d*(?:\.\d*)?[RMT]?(?:\/\d*(?:\.\d*)?)?(?=$|[\s.,>\-/])|[^\s.,>\-/]+|[\s.,>\-/]/g;
const routeTextParts = (input: string): string[] => input.toUpperCase().match(ROUTE_PARTS) ?? [];
const isDelimiter = (part: string): boolean => part.length === 1 && ROUTE_DELIMITER.test(part);

/** Used by live entry so a coordinate's slash does not prematurely commit it. */
export function hasRouteDelimiter(input: string): boolean {
  return routeTextParts(input).some(isDelimiter);
}

export function routeTokensFromText(input: string): string[] {
  return routeTextParts(input)
    .filter(part => !isDelimiter(part) && part !== 'DCT' && part !== 'DIRECT')
    .map(token => {
      const radial = parseRadialDefinition(token);
      return normalizeRouteCoordinate(token) ?? (radial ? radialDefinitionText(radial) : token);
    });
}

export function normalizeRouteToken(value: string): string {
  return value.trim().toUpperCase();
}

export function routeTokenForFeature(feature: GeoPointFeature): string {
  // A display name is not a route identifier: it can create several tokens and
  // displace every pin after a map edit. Skip blank aliases before trying the next.
  for (const token of featureIdentifiers(feature)) {
    if (feature.properties.kind === 'coordinate' && parseRadialDefinition(token)) return token;
    if (!ROUTE_DELIMITER.test(token) && token !== 'DCT' && token !== 'DIRECT') return token;
  }
  return '';
}
