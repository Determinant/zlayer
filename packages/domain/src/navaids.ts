import { normalizeIdentifier } from './features.js';

/** Accepted feed spellings, shared with the map's style expressions. */
export const NAVAID_TYPE_ALIASES = {
  'VOR/DME': ['VOR/DME', 'VORDME', 'VOR-DME'],
  'NDB/DME': ['NDB/DME', 'NDBDME', 'NDB-DME'],
};

export function normalizeNavaidType(value: string | undefined): string {
  const type = normalizeIdentifier(value) ?? '';
  return Object.entries(NAVAID_TYPE_ALIASES).find(([, aliases]) => aliases.includes(type))?.[0] ?? type;
}
