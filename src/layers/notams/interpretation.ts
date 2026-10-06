export const subjects: Record<string, string> = { RWY: 'Runway', TWY: 'Taxiway', APRON: 'Apron', AD: 'Aerodrome',
  OBST: 'Obstruction', NAV: 'Navigation', COM: 'Communications', SVC: 'Services', AIRSPACE: 'Airspace',
  ODP: 'Departure', SID: 'Departure', STAR: 'Arrival', CHART: 'Chart', DATA: 'Data', DVA: 'Vector Area',
  IAP: 'Approach', VFP: 'Visual Procedure', ROUTE: 'Route', SPECIAL: 'Special', SECURITY: 'Security' };
export type NotamEvidence = { start: number; end: number; text: string };
export type NotamFlairTone = 'info' | 'procedure' | 'caution' | 'danger' | 'neutral';
/** Semantic kinds stay stable when summary wording or badge selection changes. */
export type NotamFactKind = 'subject' | 'procedure' | 'runway' | 'taxiway' | 'closure' | 'closure-restriction' | 'outage' | 'monitoring'
  | 'restriction' | 'activity' | 'minima' | 'visibility' | 'sidestep' | 'circling' | 'vdp' | 'takeoff' | 'climb'
  | 'obstacle-kind' | 'obstacle-lighting' | 'obstacle-marking' | 'altitude' | 'lighting-note' | 'reference';
export type NotamFact = { kind: NotamFactKind; label: string; tone: NotamFlairTone; evidence: NotamEvidence;
  /** Only supplied when the complete effect applies to this explicit identity. */
  scope?: string };
export type NotamFlair = { label: string; tone: NotamFlairTone; evidence: NotamEvidence[] };
export type NotamInterpretationIssue = 'subject' | 'procedure-target' | 'procedure-exceptions' | 'facility-dependency'
  | 'headings' | 'fact-limit' | 'body-limit';
export type NotamTarget = { title: string; amendment?: string; evidence: NotamEvidence };
export type ParsedNotam = { body: string; subject: string | undefined; facts: NotamFact[];
  targets: NotamTarget[]; broad: boolean; broadRestricted: boolean; runwayTargets: string[];
  facilityTarget?: { facility: string; runway: string; effect: 'unavailable' | 'unmonitored' }; procedureNotice: boolean;
  issues: NotamInterpretationIssue[]; unresolved: boolean };
/** Dependencies established by a runway-specific navigation notice, not inferred from proximity. */
export const approachFacilities = new Set(['ILS', 'LOC', 'GP', 'GS', 'LOC/GP', 'LOC/GS']);
export const evidence = (body: string, start: number, length: number): NotamEvidence => ({ start, end: start + length, text: body.slice(start, start + length) });
export function normalizeRunway(value: string): string { return value.toUpperCase().replace(/^0(?=\d)/, ''); }
