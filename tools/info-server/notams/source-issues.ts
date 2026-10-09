import { isNotamAirportQuery, isNotamNavaidQuery, isNotamRegionQuery, type NotamSourceIssue } from '@zlayer/contracts';
import { notamContentDifferences, resolveNotamFilingScope } from './revision';

/** The same filing-scope proof owns query publication and readiness. A conflict
 * is nonblocking only when its complete evidence establishes usable content and
 * none of its disputed associations can select a supported ICAO/FIR query. Raw
 * source identifiers remain intact even when they are outside our query grammar. */
export function classifyNotamIssue(issue: NotamSourceIssue) {
  const resolved = resolveNotamFilingScope(issue);
  const affectedIcaoQueries = issue.icaoLocations.filter(code => !resolved?.icaoLocations.includes(code) &&
    (isNotamAirportQuery({ icaoId: code }) || isNotamRegionQuery({ firId: code }))).sort();
  const affectedLocationQueries = issue.locations.filter(code => !resolved?.locations.includes(code) &&
    (isNotamAirportQuery({ faaId: code }) || isNotamNavaidQuery({ navaidId: code }) || isNotamRegionQuery({ artccId: code }))).sort();
  return { resolved, affectedIcaoQueries, affectedLocationQueries,
    blocking: !resolved || affectedIcaoQueries.length > 0 || affectedLocationQueries.length > 0 };
}

export function describeNotamIssue(issue: NotamSourceIssue, classification: ReturnType<typeof classifyNotamIssue>) {
  const { resolved, blocking, affectedIcaoQueries, affectedLocationQueries } = classification;
  const fields = [...new Set(issue.variants.slice(1).flatMap(variant =>
    notamContentDifferences(issue.variants[0]!, variant)))].sort();
  return { id: issue.id, kind: resolved ? 'association' as const : 'content' as const,
    reason: issue.reason, locations: issue.locations, blocking, fields,
    icaoLocationVariants: issue.variants.map(variant => variant.icaoLocations),
    affectedIcaoQueries, affectedLocationQueries, variantsTruncated: issue.variantsTruncated, unscoped: issue.unscoped,
    impact: !resolved ? 'unresolved-content' as const : blocking ? 'association-queries' as const : 'metadata-only' as const,
    operatorAction: blocking ? 'review-source' as const : 'none' as const,
    resolution: 'A newer reconciled source revision or qualified full-snapshot withdrawal can clear the retained issue.' };
}

export type NotamIssueSummary = { total: number; associationOnly: number; contentUnresolved: number; unscoped: number;
  blocking: number; nonBlocking: number; samples: ReturnType<typeof describeNotamIssue>[]; samplesTruncated: boolean };
export const emptyNotamIssueSummary = (): NotamIssueSummary => ({ total: 0, associationOnly: 0,
  contentUnresolved: 0, unscoped: 0, blocking: 0, nonBlocking: 0, samples: [], samplesTruncated: false });
