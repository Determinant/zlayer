import type { ApproachFix, GeoPointFeature } from '@zlayer/contracts';
import { distanceNm } from './route.js';

/** Published reference rounding only; a shared name does not establish identity. */
export const TERMINAL_FIX_TOLERANCE_NM = 0.01;
export const terminalFixId = (fix: ApproachFix) => `approach-fix:${JSON.stringify([fix.ident, ...fix.coordinate])}`;
export function terminalFixFeature(fix: ApproachFix): GeoPointFeature {
  return { type: 'Feature', id: terminalFixId(fix), geometry: { type: 'Point', coordinates: fix.coordinate },
    properties: { ident: fix.ident, name: fix.ident } };
}
export const sameTerminalFix = (a: ApproachFix, b: ApproachFix) =>
  a.ident === b.ident && distanceNm(a.coordinate, b.coordinate) < TERMINAL_FIX_TOLERANCE_NM;
