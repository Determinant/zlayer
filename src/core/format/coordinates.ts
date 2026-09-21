import { parseRouteCoordinate } from '@zlayer/domain';

/** Display GPS identifiers in degrees/minutes while retaining filing precision. */
export function formatWaypointLabel(ident: string): string {
  return parseRouteCoordinate(ident)
    ? ident.replace(/^(\d{2})(\d{2})\d{2}([NS])(\d{3})(\d{2})\d{2}([EW])$/, '$1°$2′$3 $4°$5′$6')
    : ident;
}
