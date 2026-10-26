import { isNotamAirportQuery, isNotamNavaidQuery, isNotamRegionQuery, type NotamSourceIssue } from '@zlayer/contracts';
import { compareNotamContent, resolveNotamFilingScope } from './revision';
import { assessNotamApplicability } from './impact';

/** Filing-scope proof and fixed-interval assessment own query publication and
 * readiness together. Current uncertainty blocks supported affected queries;
 * historical qualification preserves the issue and all raw source identifiers. */
export function classifyNotamIssue(issue: NotamSourceIssue, now = Date.now()) {
  const resolved = resolveNotamFilingScope(issue);
  const applicability = assessNotamApplicability(issue, now);
  const affectedIcaoQueries = issue.icaoLocations.filter(code => !resolved?.icaoLocations.includes(code) &&
    (isNotamAirportQuery({ icaoId: code }) || isNotamRegionQuery({ firId: code }))).sort();
  const affectedLocationQueries = issue.locations.filter(code => !resolved?.locations.includes(code) &&
    (isNotamAirportQuery({ faaId: code }) || isNotamNavaidQuery({ navaidId: code }) || isNotamRegionQuery({ artccId: code }))).sort();
  const metadataOnly = !!resolved && affectedIcaoQueries.length === 0 && affectedLocationQueries.length === 0;
  return { resolved, affectedIcaoQueries, affectedLocationQueries, applicability, metadataOnly,
    blocking: applicability.state !== 'historical' && !metadataOnly };
}

export function describeNotamIssue(issue: NotamSourceIssue, classification: ReturnType<typeof classifyNotamIssue>) {
  const { resolved, blocking, affectedIcaoQueries, affectedLocationQueries, applicability } = classification;
  const comparisons = issue.variants.slice(1).map(variant => {
    const { outcome, fields, text } = compareNotamContent(issue.variants[0]!, variant);
    return { outcome, fields, proof: text.proof, reason: text.failure };
  });
  const fields = [...new Set(comparisons.flatMap(comparison => comparison.fields))].sort();
  return { id: issue.id, kind: resolved ? 'association' as const : 'content' as const,
    sourceRevision: issue.variants[0]!.sourceUpdatedAt,
    observations: issue.observations ?? null, applicability,
    reason: issue.reason, locations: issue.locations, blocking, fields,
    icaoLocationVariants: issue.variants.map(variant => variant.icaoLocations),
    affectedIcaoQueries, affectedLocationQueries, comparisons, variantsTruncated: issue.variantsTruncated, unscoped: issue.unscoped,
    impact: applicability.state === 'historical' ? 'historical' as const
      : !resolved ? 'unresolved-content' as const : blocking ? 'association-queries' as const : 'metadata-only' as const,
    operatorAction: blocking ? 'review-source' as const : 'none' as const,
    resolution: 'A newer reconciled source revision or qualified full-snapshot withdrawal can clear the retained issue.' };
}

type NotamIssueSummary = { total: number; associationOnly: number; contentUnresolved: number; unscoped: number; historical: number;
  historicalMetadata: number; blocking: number; nonBlocking: number; samples: ReturnType<typeof describeNotamIssue>[]; samplesTruncated: boolean };
export const emptyNotamIssueSummary = (): NotamIssueSummary => ({ total: 0, associationOnly: 0,
  contentUnresolved: 0, unscoped: 0, historical: 0, historicalMetadata: 0, blocking: 0, nonBlocking: 0, samples: [], samplesTruncated: false });
