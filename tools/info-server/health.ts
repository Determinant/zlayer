import { NOTAM_STALE_MS, RADAR_MAX_AGE, TFR_STALE_MS, type NotamFeedStatus } from '@zlayer/contracts';
import { NOTAM_FULL_SYNC_MAX_AGE } from './notams/policy';
import { ADVISORY_MAX_AGE_MS } from './weather-resources';

// The HTTP summary and artifact probe share these freshness policies. Availability
// still belongs to each product; expected geographic/publication gaps are coverage.
export const INFO_FRESHNESS = { gridCheck: 90 * 60_000, modelRun: 3 * 3600_000, charts: 10 * 60_000,
  analysis: 6 * 3600_000, advisory: ADVISORY_MAX_AGE_MS, radar: RADAR_MAX_AGE, notams: NOTAM_STALE_MS,
  fullSync: NOTAM_FULL_SYNC_MAX_AGE, tfrs: TFR_STALE_MS } as const;
export function freshAt(time: unknown, now: number, maxAge: number, futureTolerance = 30_000): boolean {
  return typeof time === 'number' && Number.isFinite(time) && time <= now + futureTolerance && now - time < maxAge;
}
type Published = { ready: boolean; checkedAt?: number | null | undefined; error?: string | null | undefined;
  nextAttemptAt?: number | null | undefined; unresolvedRecords?: number; errorDetail?: string | null;
  interpretation?: { classification: { sourceDurationAnomalies?: number } } | null };
type Forecast = Published & { runTime?: number | undefined; validThrough?: number | undefined };
type Charts = Published & { validTimes?: number[] | undefined; unavailableTimes?: number[] | undefined };
type Radar = Published & { observedAt?: number | undefined; unavailable?: string[] | undefined };
type Motion = Published & { newestObservedAt?: number | null | undefined; unavailable: number };
export type InfoHealthInput = {
  forecasts: Record<string, Forecast>; progs: Record<string, Charts>; progsCoverage: Charts & { analysisTime?: number | undefined };
  radar: Radar; radarMotion: Motion; advisories: Record<string, Published>; notams: NotamFeedStatus;
  pireps: Published;
  tfrs: Published & { unresolvedRecords: number };
  notamReconciliation: { state: string; error: string | null; nextAttemptAt: number } | null;
};
type FreshnessCheck = { clock: string; timestamp: number | null; fresh: boolean; maxAgeMs?: number };
type SourceHealth = { available: boolean; fresh: boolean; coverage: 'complete' | 'partial' | 'unknown';
  checkedAt: number | null; nextAttemptAt: number | null; error: string | null; errorDetail?: string | null; freshness?: FreshnessCheck[] };
type HealthProblem = { product: string; reason: string; severity: 'error' | 'warning' };
type HealthNotice = { product: string; reason: string; severity: 'info'; count: number };
export function assessInfoHealth(input: InfoHealthInput, now: number) {
  const sources: Record<string, SourceHealth> = {}, problems: HealthProblem[] = [], warnings: HealthProblem[] = [];
  const notices: HealthNotice[] = [];
  const age = (clock: string, timestamp: number | null | undefined, maxAgeMs: number, tolerance = 0): FreshnessCheck =>
    ({ clock, timestamp: timestamp ?? null, maxAgeMs, fresh: freshAt(timestamp, now, maxAgeMs, tolerance) });
  const horizon = (timestamp: number | undefined): FreshnessCheck =>
    ({ clock: 'forecast-horizon', timestamp: timestamp ?? null, fresh: timestamp !== undefined && timestamp >= now });
  function source(name: string, value: Published, maxAge: number, options: { valid?: boolean; checks?: FreshnessCheck[]; coverage?: SourceHealth['coverage'] } = {}) {
    const freshness = [age('source-check', value.checkedAt, maxAge, 30_000), ...(options.checks ?? [])];
    const fresh = freshness.every(check => check.fresh) && options.valid !== false;
    sources[name] = { available: value.ready, fresh, coverage: options.coverage ?? 'complete', checkedAt: value.checkedAt ?? null,
      nextAttemptAt: value.nextAttemptAt ?? null, error: value.error ?? null, errorDetail: value.errorDetail ?? null, freshness };
    const reason = !value.ready ? 'unavailable' : !fresh ? 'stale' : value.error;
    if (reason) problems.push({ product: name, reason, severity: 'error' });
  }
  for (const product of ['clouds', 'icing', 'winds']) {
    const value = input.forecasts[product] ?? { ready: false };
    source(product, value, INFO_FRESHNESS.gridCheck,
      { checks: [age('model-run', value.runTime, INFO_FRESHNESS.modelRun), horizon(value.validThrough)] });
  }
  for (const product of ['analysis', 'forecast']) {
    const value = input.progs[product] ?? { ready: false };
    source(`progs.${product}`, value, INFO_FRESHNESS.charts,
      { checks: product === 'analysis' ? [age('analysis-valid', value.validTimes?.[0], INFO_FRESHNESS.analysis)] : [horizon(value.validTimes?.length ? Math.max(...value.validTimes) : undefined)] });
  }
  const coverage = input.progsCoverage;
  const coverageTimes = [...(coverage.validTimes ?? []), ...(coverage.unavailableTimes ?? [])];
  // Unpublished images still belong to the catalog horizon. Availability needs
  // at least one saved image, independently of which future stops have images.
  source('progs.coverage', { ...coverage, ready: coverage.ready && !!coverage.validTimes?.length }, INFO_FRESHNESS.charts,
    { checks: [age('analysis-valid', coverage.analysisTime, INFO_FRESHNESS.analysis), horizon(coverageTimes.length ? Math.max(...coverageTimes) : undefined)],
      coverage: coverage.unavailableTimes?.length ? 'partial' : 'complete' });
  source('radar', input.radar, INFO_FRESHNESS.radar, { checks: [age('radar-observation', input.radar.observedAt, INFO_FRESHNESS.radar)],
    coverage: input.radar.unavailable?.length ? 'partial' : 'complete' });
  source('radarMotion', input.radarMotion, INFO_FRESHNESS.radar, { checks: [age('radar-observation', input.radarMotion.newestObservedAt, INFO_FRESHNESS.radar)],
    coverage: input.radarMotion.unavailable ? 'partial' : 'complete' });
  for (const product of ['gairmet', 'sigmet', 'cwa']) {
    const value = input.advisories[product] ?? { ready: false };
    source(`advisory.${product}`, value, INFO_FRESHNESS.advisory,
      { coverage: !value.ready ? 'unknown' : value.unresolvedRecords ? 'partial' : 'complete' });
    if (value.interpretation?.classification.sourceDurationAnomalies)
      warnings.push({ product: `advisory.${product}`, reason: 'source-duration-anomaly', severity: 'warning' });
  }
  source('pireps', input.pireps, INFO_FRESHNESS.advisory,
    { coverage: input.pireps.ready ? 'complete' : 'unknown' });
  source('tfrs', input.tfrs, INFO_FRESHNESS.tfrs, { coverage: input.tfrs.unresolvedRecords ? 'partial' : 'complete' });
  const feed = input.notams;
  if (feed.enabled) {
    source('notams', { ready: feed.generation !== null, checkedAt: feed.checkedAt, error: feed.error, nextAttemptAt: feed.nextAttemptAt },
      INFO_FRESHNESS.notams, { valid: (feed.collectionContinuity ?? feed.continuity) === 'complete', coverage: feed.continuity === 'complete' ? 'complete' : 'partial' });
    // The collector proves these members have agreed content and no affected
    // supported queries. Keep their evidence visible without asking an operator
    // to repair a healthy feed. Unknown/legacy impact remains blocking.
    const metadata = (feed.unresolvedRecords ?? 0) - (feed.historicalIssues ?? 0) - (feed.blockingRecords ?? feed.unresolvedRecords ?? 0);
    if (metadata > 0) notices.push({ product: 'notams', reason: 'association-metadata', severity: 'info', count: metadata });
    if (feed.historicalIssues) warnings.push({ product: 'notams', reason: 'historical-source-issues', severity: 'warning' });
    const reconciliation = input.notamReconciliation;
    const overdue = !freshAt(feed.fullSyncAt, now, INFO_FRESHNESS.fullSync, 0);
    if (overdue || reconciliation?.error) problems.push({ product: 'notams.reconciliation',
      reason: reconciliation?.error ?? 'full-sync-overdue', severity: 'warning' });
  }
  return { ready: problems.length === 0, state: problems.some(problem => problem.reason === 'unavailable') ? 'unavailable'
    : problems.length ? 'degraded' : 'ready', sources, problems, warnings, notices };
}
