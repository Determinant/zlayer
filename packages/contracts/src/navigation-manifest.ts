import { isTerminalCoverage, type TerminalCoverage } from './terminal-procedures.js';
import { isRecord, isIsoDate, isSha256, isNonEmptyString, isNonNegativeInteger as count, hasUniqueStrings } from './validation.js';

export type NavigationProduct = {
  id: string; file: string; count: number;
  jsonSha256?: string;
  vfrWaypointCount?: number;
  schemaVersion?: 2; coverage?: TerminalCoverage;
  compression?: unknown; routeCount?: unknown; bytes?: unknown; uncompressedBytes?: unknown;
  source?: unknown; observationRange?: unknown;
};
export type NavigationManifest = {
  schemaVersion: 1 | 2 | 3; effectiveDate: string; generatedAt: string; products: NavigationProduct[];
};
export const REQUIRED_NAVIGATION_PRODUCTS = ['airports', 'fixes', 'vfr-waypoints', 'navaids', 'airways',
  'preferred-routes', 'terminal-procedures', 'magnetic-model', 'nasr-coverage', 'cifp-source'] as const;
const REQUIRED_NAVIGATION_PRODUCTS_V3 = ['airports', 'fixes', 'navaids', 'airways',
  'preferred-routes', 'terminal-procedures', 'magnetic-model'] as const;

/** V1 is an explicit legacy contract. V2 and V3 products are immutable and identify
 * their parsed JSON as well as their wire bytes. Never infer completeness from a date. */
export function isNavigationManifest(value: unknown): value is NavigationManifest {
  if (!isRecord(value) || ![1, 2, 3].includes(value.schemaVersion as number) ||
      !isIsoDate(value.effectiveDate) || !isNonEmptyString(value.generatedAt) || !Number.isFinite(Date.parse(value.generatedAt)) ||
      !Array.isArray(value.products)) return false;
  const products = value.products;
  if (value.schemaVersion === 2 && REQUIRED_NAVIGATION_PRODUCTS.some(id => !products.some(p => isRecord(p) && p.id === id))) return false;
  if (value.schemaVersion === 3 && (REQUIRED_NAVIGATION_PRODUCTS_V3.some(id => !products.some(p => isRecord(p) && p.id === id)) ||
      products.some(p => isRecord(p) && ['vfr-waypoints', 'nasr-coverage', 'cifp-source'].includes(p.id as string)))) return false;
  return products.every(p => {
    if (!isRecord(p) || !isNonEmptyString(p.id) || typeof p.file !== 'string' ||
        !/^[\w.-]+$/.test(p.file) || p.file.startsWith('.') || !count(p.count)) return false;
    if (value.schemaVersion === 1) return p.jsonSha256 === undefined || isSha256(p.jsonSha256);
    return isSha256(p.sha256) && p.file.includes(`.${p.sha256}.`) && count(p.bytes) && p.bytes > 0 &&
      (value.schemaVersion === 2 && p.id === 'cifp-source' || isSha256(p.jsonSha256)) &&
      (p.id !== 'terminal-procedures' || p.schemaVersion === 2 && isTerminalCoverage(p.coverage)) &&
      (value.schemaVersion !== 3 || p.id !== 'fixes' || count(p.vfrWaypointCount) && p.vfrWaypointCount <= p.count);
  }) && hasUniqueStrings(value.products.map(p => p.id as string));
}
