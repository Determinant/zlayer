import { isIsoDate } from './validation.js';

/** FAA sectional, terminal, flyway and enroute raster charts have 56-day editions.
 * Keep their source date separate from the selected navigation/TPP cycle.
 * https://www.faa.gov/air_traffic/publications/atpubs/aim_html/chap9_section_1.html
 */
export function chartEditionCoversCycle(edition: string, cycle: string): boolean {
  // Preserve existing same-edition catalogs, including legacy non-ISO labels.
  if (edition === cycle) return true;
  if (!isIsoDate(edition) || !isIsoDate(cycle)) return false;
  const age = Date.parse(`${cycle}T00:00:00Z`) - Date.parse(`${edition}T00:00:00Z`);
  return age > 0 && age < 56 * 86_400_000;
}

/** US FAA editions change over at 0901Z (FAA Chart Users' Guide). */
export function faaEffectiveDate(now = Date.now()): string {
  return new Date(now - (9 * 60 + 1) * 60_000).toISOString().slice(0, 10);
}
