import { isRecord, isSha256 } from './validation.js';

export const NOTAM_REFRESH_MS = 180_000;
export const NOTAM_STALE_MS = 2 * NOTAM_REFRESH_MS;
export const NOTAM_AIRPORT_MAX_RECORDS = 5000;
export const NOTAM_AIRPORT_MAX_BYTES = 16 * 1024 * 1024;
export const NOTAM_MAX_ISSUE_VARIANTS = 8;
export type NotamEnvironment = 'staging' | 'production';
export type NotamAirportQuery = { faaId?: string; icaoId?: string };
export type NotamNavaidQuery = { navaidId: string };
export type NotamRegionQuery = { artccId?: string; firId?: string };
export type NotamQuery = NotamAirportQuery | NotamNavaidQuery | NotamRegionQuery;
export type NotamRecord = {
  id: string; sourceId: string; revision: string;
  classification: string; number: string; series: string; year: string;
  locations: string[]; icaoLocations: string[]; accountability: string;
  /** Query projection: conflicting source association sets, with only their
   * intersection in icaoLocations. Primary filing locations remain agreed. */
  icaoLocationVariants?: string[][];
  /** Original source sets when complete native/FIR evidence establishes
   * complementary lookup scopes. icaoLocations is their union, not an alias. */
  sourceIcaoLocations?: string[][];
  /** Actual numbering-year spellings retained after a witnessed omission. */
  sourceYears?: string[];
  issuedAt: number | null; updatedAt: number;
  sourceUpdatedAt: string; canceledAt: string;
  referred: { series: string; number: string; year: string } | null;
  startsAt: number | null; endsAt: number | null;
  endKind: 'fixed' | 'estimated' | 'permanent' | 'unknown';
  effectiveStart: string; effectiveEnd: string; schedule: string;
  changeType: string; lifecycle: 'active' | 'cancelled' | 'cancellation' | 'unknown';
  text: string; translations: { type: string; text: string }[];
  sequence: number; correction: number;
  /** Distinct observed AIXM counter pairs for equivalent operational content.
   * The scalar pair is a representative, never a temporal precedence decision. */
  sourceCounters?: { sequence: number; correction: number }[];
};
export type NotamFeedStatus = {
  enabled: boolean; environment: NotamEnvironment | null;
  state: 'disabled' | 'loading' | 'ready' | 'degraded' | 'unavailable';
  generation: string | null; checkedAt: number | null; watermark: number | null;
  fullSyncAt: number | null; recordCount: number;
  continuity: 'complete' | 'incomplete'; error: string | null; nextAttemptAt: number | null;
  /** Collection can advance while individual source records remain unresolved. */
  collectionContinuity?: 'complete' | 'incomplete';
  unresolvedRecords?: number;
  /** Retained issues that affect usable content or supported query associations.
   * Absence identifies older servers: treat every unresolved record as blocking. */
  blockingRecords?: number;
  /** Retained, complete issues whose agreeing fixed interval is definitely past. */
  historicalIssues?: number;
  /** Historical subset with agreed content and no disputed supported queries. */
  historicalMetadataIssues?: number;
  unscopedRecords?: number;
};
export type NotamSourceIssue = {
  id: string;
  reason: 'revision-conflict' | 'unsupported-lifecycle' | 'representation-limit';
  variants: NotamRecord[];
  /** Bounded evidence samples; overflow remains unresolved until superseded. */
  variantsTruncated: boolean;
  locations: string[]; icaoLocations: string[];
  /** Missing or over-limit associations must qualify every location query. */
  unscoped: boolean;
  /** Diagnostic observation history, independent of source ordering/freshness.
   * Null firstSeenAt preserves unknown history for pre-existing issues. */
  observations?: { firstSeenAt: number | null; lastSeenAt: number; kinds: ('bulk' | 'delta')[] };
};
export type NotamAirportSnapshot = {
  schemaVersion: 1; query: NotamAirportQuery; feed: NotamFeedStatus;
  scope: 'airport-location'; associationCoverage: 'complete' | 'incomplete';
  records: NotamRecord[];
  /** Added together; absence identifies a legacy snapshot. */
  contentCoverage?: 'complete' | 'incomplete';
  issues?: NotamSourceIssue[];
  /** Raw evidence retained separately from issues affecting this query now. */
  historicalIssues?: NotamSourceIssue[];
};
export type NotamNavaidSnapshot = Omit<NotamAirportSnapshot, 'query' | 'scope' | 'associationCoverage'> & {
  query: NotamNavaidQuery; scope: 'navaid-location';
  /** Complete for the station location; accept the old fixed incomplete flag on saved/server responses. */
  associationCoverage: 'complete' | 'incomplete';
};
export type NotamRegionSnapshot = Omit<NotamAirportSnapshot, 'query' | 'scope'> & {
  query: NotamRegionQuery; scope: 'region-location';
};
export type NotamSnapshot = NotamAirportSnapshot | NotamNavaidSnapshot | NotamRegionSnapshot;

const text = (v: unknown, max = 256 * 1024): v is string => typeof v === 'string' && v.length <= max;
const time = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v < 8.64e15;
const optionalTime = (v: unknown): v is number | null => v === null || time(v);
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const codes = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 32 &&
  v.every(s => typeof s === 'string' && /^[A-Z0-9]{2,8}$/.test(s)) && new Set(v).size === v.length;
export function isNotamAirportQuery(v: unknown): v is NotamAirportQuery {
  return isRecord(v) && Object.keys(v).every(k => k === 'faaId' || k === 'icaoId') &&
    (v.faaId !== undefined || v.icaoId !== undefined) &&
    (v.faaId === undefined || typeof v.faaId === 'string' && /^[A-Z0-9]{3,5}$/.test(v.faaId)) &&
    (v.icaoId === undefined || typeof v.icaoId === 'string' && /^[A-Z]{4}$/.test(v.icaoId));
}
export function notamAirportKey(query: NotamAirportQuery): string {
  return `faa:${query.faaId ?? ''}|icao:${query.icaoId ?? ''}`;
}
export function isNotamNavaidQuery(v: unknown): v is NotamNavaidQuery {
  return isRecord(v) && Object.keys(v).length === 1 && typeof v.navaidId === 'string' && /^[A-Z0-9]{2,5}$/.test(v.navaidId);
}
export function isNotamRegionQuery(v: unknown): v is NotamRegionQuery {
  return isRecord(v) && Object.keys(v).every(k => k === 'artccId' || k === 'firId') &&
    (v.artccId !== undefined || v.firId !== undefined) &&
    (v.artccId === undefined || typeof v.artccId === 'string' && /^Z[A-Z]{2}$/.test(v.artccId)) &&
    (v.firId === undefined || typeof v.firId === 'string' && /^[A-Z]{4}$/.test(v.firId));
}
export function isNotamQuery(v: unknown): v is NotamQuery {
  return isNotamAirportQuery(v) || isNotamNavaidQuery(v) || isNotamRegionQuery(v);
}
export function notamQueryKey(query: NotamQuery): string {
  return isNotamRegionQuery(query) ? `artcc:${query.artccId ?? ''}|fir:${query.firId ?? ''}`
    : 'navaidId' in query ? `navaid:${query.navaidId}` : notamAirportKey(query);
}
export function isNotamRecord(v: unknown): v is NotamRecord {
  return isRecord(v) && typeof v.id === 'string' && /^\d{16}$/.test(v.id) &&
    (v.sourceId === v.id || v.sourceId === `NMS_ID_${v.id}`) && isSha256(v.revision) &&
    text(v.classification, 64) && text(v.number, 64) && text(v.series, 16) && text(v.year, 8) &&
    codes(v.locations) && codes(v.icaoLocations) && text(v.accountability, 32) &&
    (v.sourceYears === undefined || Array.isArray(v.sourceYears) && v.sourceYears.length === 2 &&
      v.sourceYears.includes('') && v.sourceYears.includes(v.year) && typeof v.year === 'string' && /^\d{4}$/.test(v.year) &&
      new Set(v.sourceYears).size === 2) &&
    (v.sourceIcaoLocations === undefined || v.icaoLocationVariants === undefined && Array.isArray(v.sourceIcaoLocations) &&
      v.sourceIcaoLocations.length === 2 && v.sourceIcaoLocations.every(set => codes(set) && set.length === 1) &&
      new Set(v.sourceIcaoLocations.flat()).size === 2 &&
      [...new Set(v.sourceIcaoLocations.flat())].sort().join(',') === [...v.icaoLocations].sort().join(',')) &&
    (v.icaoLocationVariants === undefined || v.locations.length > 0 && Array.isArray(v.icaoLocationVariants) &&
      v.icaoLocationVariants.length >= 2 && v.icaoLocationVariants.length <= NOTAM_MAX_ISSUE_VARIANTS &&
      v.icaoLocationVariants.every(set => codes(set) && set.length > 0) &&
      new Set(v.icaoLocationVariants.map(set => [...set].sort().join(','))).size === v.icaoLocationVariants.length &&
      (v.icaoLocationVariants[0] as string[]).filter(code => (v.icaoLocationVariants as string[][]).every(set => set.includes(code))).sort().join(',') ===
        [...v.icaoLocations].sort().join(',')) &&
    optionalTime(v.issuedAt) && time(v.updatedAt) && optionalTime(v.startsAt) && optionalTime(v.endsAt) &&
    text(v.sourceUpdatedAt, 64) && text(v.canceledAt, 64) &&
    (v.referred === null || isRecord(v.referred) && text(v.referred.series, 16) && text(v.referred.number, 64) && text(v.referred.year, 8)) &&
    ['fixed', 'estimated', 'permanent', 'unknown'].includes(String(v.endKind)) &&
    text(v.effectiveStart, 128) && text(v.effectiveEnd, 128) && text(v.schedule, 4096) &&
    text(v.changeType, 32) && ['active', 'cancelled', 'cancellation', 'unknown'].includes(String(v.lifecycle)) &&
    text(v.text) && Array.isArray(v.translations) && v.translations.length <= 8 &&
    v.translations.every(t => isRecord(t) && text(t.type, 64) && text(t.text)) &&
    integer(v.sequence) && integer(v.correction) &&
    (v.sourceCounters === undefined || Array.isArray(v.sourceCounters) &&
      v.sourceCounters.length >= 2 && v.sourceCounters.length <= NOTAM_MAX_ISSUE_VARIANTS &&
      v.sourceCounters.every(c => isRecord(c) && integer(c.sequence) && integer(c.correction)) &&
      new Set(v.sourceCounters.map(c => `${c.sequence}:${c.correction}`)).size === v.sourceCounters.length &&
      v.sourceCounters.some(c => c.sequence === v.sequence && c.correction === v.correction));
}
export function isNotamFeedStatus(v: unknown): v is NotamFeedStatus {
  return isRecord(v) && typeof v.enabled === 'boolean' &&
    (v.environment === null || v.environment === 'staging' || v.environment === 'production') &&
    ['disabled', 'loading', 'ready', 'degraded', 'unavailable'].includes(String(v.state)) &&
    (v.generation === null || isSha256(v.generation)) && optionalTime(v.checkedAt) &&
    optionalTime(v.watermark) && optionalTime(v.fullSyncAt) && integer(v.recordCount) &&
    (v.continuity === 'complete' || v.continuity === 'incomplete') &&
    (v.error === null || typeof v.error === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(v.error)) && optionalTime(v.nextAttemptAt) &&
    (v.blockingRecords === undefined || integer(v.blockingRecords) && integer(v.unresolvedRecords) && integer(v.unscopedRecords) &&
      v.unscopedRecords <= v.blockingRecords && v.blockingRecords <= v.unresolvedRecords &&
      (v.state !== 'ready' || v.blockingRecords === 0)) &&
    (v.historicalIssues === undefined || integer(v.historicalIssues) && integer(v.blockingRecords) && integer(v.unresolvedRecords) &&
      v.historicalIssues + v.blockingRecords <= v.unresolvedRecords) &&
    (v.historicalMetadataIssues === undefined || integer(v.historicalMetadataIssues) && integer(v.historicalIssues) &&
      v.historicalMetadataIssues <= v.historicalIssues) &&
    (v.collectionContinuity === undefined && v.unresolvedRecords === undefined && v.unscopedRecords === undefined ||
      ['complete', 'incomplete'].includes(String(v.collectionContinuity)) && integer(v.unresolvedRecords) &&
      integer(v.unscopedRecords) && v.unscopedRecords <= v.unresolvedRecords && v.unresolvedRecords <= v.recordCount &&
      (v.continuity !== 'complete' || v.collectionContinuity === 'complete' && v.unresolvedRecords === 0));
}
export function isNotamSourceIssue(v: unknown): v is NotamSourceIssue {
  return isRecord(v) && typeof v.id === 'string' && /^\d{16}$/.test(v.id) &&
    ['revision-conflict', 'unsupported-lifecycle', 'representation-limit'].includes(String(v.reason)) &&
    typeof v.variantsTruncated === 'boolean' && typeof v.unscoped === 'boolean' && codes(v.locations) && codes(v.icaoLocations) &&
    Array.isArray(v.variants) && v.variants.length > 0 && v.variants.length <= NOTAM_MAX_ISSUE_VARIANTS &&
    v.variants.every(r => isNotamRecord(r) && r.id === v.id &&
      (v.unscoped || (r.locations.length > 0 || r.icaoLocations.length > 0) &&
        r.locations.every(code => (v.locations as string[]).includes(code)) &&
        r.icaoLocations.every(code => (v.icaoLocations as string[]).includes(code)))) &&
    new Set(v.variants.map(r => r.revision)).size === v.variants.length &&
    (v.observations === undefined || isRecord(v.observations) && optionalTime(v.observations.firstSeenAt) && time(v.observations.lastSeenAt) &&
      (v.observations.firstSeenAt === null || v.observations.firstSeenAt <= v.observations.lastSeenAt) &&
      Array.isArray(v.observations.kinds) && v.observations.kinds.length >= 1 && v.observations.kinds.length <= 2 &&
      v.observations.kinds.every(kind => kind === 'bulk' || kind === 'delta') && new Set(v.observations.kinds).size === v.observations.kinds.length);
}
export function isNotamAirportSnapshot(v: unknown): v is NotamAirportSnapshot {
  return isRecord(v) && v.scope === 'airport-location' && isNotamAirportQuery(v.query) && isSnapshotContent(v);
}
export function isNotamNavaidSnapshot(v: unknown): v is NotamNavaidSnapshot {
  return isRecord(v) && v.scope === 'navaid-location' && isNotamNavaidQuery(v.query) && isSnapshotContent(v);
}
export function isNotamRegionSnapshot(v: unknown): v is NotamRegionSnapshot {
  return isRecord(v) && v.scope === 'region-location' && isNotamRegionQuery(v.query) && isSnapshotContent(v);
}
export function isNotamSnapshot(v: unknown): v is NotamSnapshot {
  return isNotamAirportSnapshot(v) || isNotamNavaidSnapshot(v) || isNotamRegionSnapshot(v);
}
function isSnapshotContent(v: Record<string, unknown>): boolean {
  const historical = v.historicalIssues ?? [];
  return v.schemaVersion === 1 &&
    isNotamFeedStatus(v.feed) && v.feed.generation !== null && v.feed.environment !== null &&
    ['complete', 'incomplete'].includes(String(v.associationCoverage)) &&
    Array.isArray(v.records) && v.records.length <= NOTAM_AIRPORT_MAX_RECORDS && v.records.every(isNotamRecord) &&
    new Set(v.records.map(r => r.id)).size === v.records.length &&
    Array.isArray(historical) && historical.every(issue => isNotamSourceIssue(issue) && !issue.unscoped && !issue.variantsTruncated &&
      issue.reason === 'revision-conflict' && issue.variants.length >= 2 && issue.variants[0]!.startsAt !== null &&
      issue.variants[0]!.endsAt !== null && issue.variants[0]!.endsAt! > issue.variants[0]!.startsAt! &&
      issue.variants.every(record => record.lifecycle === 'active' && record.endKind === 'fixed' &&
        record.startsAt === issue.variants[0]!.startsAt && record.endsAt === issue.variants[0]!.endsAt)) &&
    historical.length <= (v.feed.historicalIssues ?? 0) &&
    (v.historicalIssues === undefined || v.issues !== undefined && v.contentCoverage !== undefined) &&
    (v.contentCoverage === undefined && v.issues === undefined ||
      ['complete', 'incomplete'].includes(String(v.contentCoverage)) && Array.isArray(v.issues) &&
      v.records.length + v.issues.length + historical.length <= NOTAM_AIRPORT_MAX_RECORDS && v.issues.every(isNotamSourceIssue) &&
      new Set([...v.records, ...v.issues, ...historical].map(r => r.id)).size === v.records.length + v.issues.length + historical.length &&
      v.feed.collectionContinuity !== undefined && (v.feed.unresolvedRecords ?? 0) >= v.issues.length + historical.length &&
      v.issues.filter(issue => issue.unscoped).length === v.feed.unscopedRecords &&
      (v.contentCoverage !== 'complete' || v.feed.collectionContinuity === 'complete' && v.issues.length === 0));
}
