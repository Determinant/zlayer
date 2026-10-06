import { isNotamNavaidQuery, type GeoPointFeature, type NotamNavaidQuery, type NotamRecord } from '@zlayer/contracts';
import { normalizeNavaidType } from '@zlayer/domain';
import { localNotamContent, parseNotam } from './parser';

export type NavaidNotamContext = { query: NotamNavaidQuery; type: string };

/** NASR notamId is accountability, not the affected station's location ID. */
export function navaidNotamContext(feature: GeoPointFeature): NavaidNotamContext | undefined {
  const { kind, ident, type, country } = feature.properties;
  if (kind !== 'navaid' || country !== 'US' || typeof ident !== 'string' || typeof type !== 'string') return;
  const query = { navaidId: ident.trim().toUpperCase() }, normalized = normalizeNavaidType(type);
  return isNotamNavaidQuery(query) && normalized ? { query, type: normalized } : undefined;
}

const components: Record<string, readonly string[]> = {
  VORTAC: ['VORTAC', 'VOR', 'TACAN', 'DME'],
  'VOR/DME': ['VOR/DME', 'VOR', 'DME'],
  'NDB/DME': ['NDB/DME', 'NDB', 'DME'],
  TACAN: ['TACAN', 'DME'],
  'MARINE NDB': ['NDB'],
};

/** Bounded station/component references, not a procedure-dependency inference.
 * Other location notices remain accessible, including unfamiliar NAV wording. */
export function partitionNavaidNotams(records: readonly NotamRecord[], context: NavaidNotamContext) {
  const related: NotamRecord[] = [], other: NotamRecord[] = [];
  for (const record of records) {
    const content = localNotamContent(parseNotam(record).body, record).trim().toUpperCase().replace(/\s+/g, ' ');
    const heading = /^(NAV|COM) (?:([A-Z0-9]{2,5}) )?(VOR\/DME|NDB\/DME|VORTAC|VOR|DME|TACAN|NDB|VOT)\b(.*)$/.exec(content);
    const supported = heading && (!heading[2] || heading[2] === context.query.navaidId) &&
      (components[context.type] ?? [context.type]).includes(heading[3]!) &&
      (heading[1] === 'NAV' || /^ VOICE\b/.test(heading[4]!));
    (record.locations.includes(context.query.navaidId) && supported ? related : other).push(record);
  }
  return { related, other };
}
