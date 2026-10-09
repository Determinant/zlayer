import { NOTAM_STALE_MS, RADAR_MAX_AGE, TFR_STALE_MS, type NotamFeedStatus } from '@zlayer/contracts';
import { NOTAM_FULL_SYNC_MAX_AGE } from './notams/policy';

// The HTTP summary and artifact probe share these freshness policies. Availability
// still belongs to each product; expected geographic/publication gaps are coverage.
export const INFO_FRESHNESS = { gridCheck: 90 * 60_000, modelRun: 3 * 3600_000, charts: 10 * 60_000,
  analysis: 6 * 3600_000, advisory: 10 * 60_000, radar: RADAR_MAX_AGE, notams: NOTAM_STALE_MS,
  fullSync: NOTAM_FULL_SYNC_MAX_AGE, tfrs: TFR_STALE_MS } as const;
export function freshAt(time: unknown, now: number, maxAge: number, futureTolerance = 30_000): boolean {
  return typeof time === 'number' && Number.isFinite(time) && time <= now + futureTolerance && now - time < maxAge;
}
type Published = { ready: boolean; checkedAt?: number | null | undefined; error?: string | null | undefined;
  nextAttemptAt?: number | null | undefined; unresolvedRecords?: number };
type Forecast = Published & { runTime?: number | undefined; validThrough?: number | undefined };
type Charts = Published & { validTimes?: number[] | undefined; unavailableTimes?: number[] | undefined };
type Radar = Published & { observedAt?: number | undefined; unavailable?: string[] | undefined };
type Motion = Published & { newestObservedAt?: number | null | undefined; unavailable: number };
export type InfoHealthInput = {
  forecasts: Record<string, Forecast>; progs: Record<string, Charts>; progsCoverage: Charts & { analysisTime?: number | undefined };
  radar: Radar; radarMotion: Motion; advisories: Record<string, Published>; notams: NotamFeedStatus;
  tfrs: Published & { unresolvedRecords: number };
  notamReconciliation: { state: string; error: string | null; nextAttemptAt: number } | null;
};
export type SourceHealth = { available: boolean; fresh: boolean; coverage: 'complete' | 'partial' | 'unknown';
  checkedAt: number | null; nextAttemptAt: number | null; error: string | null };
export type HealthProblem = { product: string; reason: string; severity: 'error' | 'warning' };
export function assessInfoHealth(input: InfoHealthInput, now: number) {
  const sources: Record<string, SourceHealth> = {}, problems: HealthProblem[] = [], warnings: HealthProblem[] = [];
  function source(name: string, value: Published, maxAge: number, options: { valid?: boolean; coverage?: SourceHealth['coverage'] } = {}) {
    const fresh = freshAt(value.checkedAt, now, maxAge) && options.valid !== false;
    sources[name] = { available: value.ready, fresh, coverage: options.coverage ?? 'complete', checkedAt: value.checkedAt ?? null,
      nextAttemptAt: value.nextAttemptAt ?? null, error: value.error ?? null };
    const reason = !value.ready ? 'unavailable' : !fresh ? 'stale' : value.error;
    if (reason) problems.push({ product: name, reason, severity: 'error' });
  }
  for (const product of ['clouds', 'icing', 'winds']) {
    const value = input.forecasts[product] ?? { ready: false };
    source(product, value, INFO_FRESHNESS.gridCheck,
      { valid: freshAt(value.runTime, now, INFO_FRESHNESS.modelRun, 0) && typeof value.validThrough === 'number' && value.validThrough >= now });
  }
  for (const product of ['analysis', 'forecast']) {
    const value = input.progs[product] ?? { ready: false };
    source(`progs.${product}`, value, INFO_FRESHNESS.charts,
      { valid: product === 'analysis' ? freshAt(value.validTimes?.[0], now, INFO_FRESHNESS.analysis, 0) : value.validTimes?.some(time => time >= now) === true });
  }
  const coverage = input.progsCoverage;
  const coverageTimes = [...(coverage.validTimes ?? []), ...(coverage.unavailableTimes ?? [])];
  // Unpublished images still belong to the catalog horizon. Availability needs
  // at least one saved image, independently of which future stops have images.
  source('progs.coverage', { ...coverage, ready: coverage.ready && !!coverage.validTimes?.length }, INFO_FRESHNESS.charts,
    { valid: freshAt(coverage.analysisTime, now, INFO_FRESHNESS.analysis, 0) && coverageTimes.some(time => time >= now),
      coverage: coverage.unavailableTimes?.length ? 'partial' : 'complete' });
  source('radar', input.radar, INFO_FRESHNESS.radar, { valid: freshAt(input.radar.observedAt, now, INFO_FRESHNESS.radar, 0),
    coverage: input.radar.unavailable?.length ? 'partial' : 'complete' });
  source('radarMotion', input.radarMotion, INFO_FRESHNESS.radar, { valid: freshAt(input.radarMotion.newestObservedAt, now, INFO_FRESHNESS.radar, 0),
    coverage: input.radarMotion.unavailable ? 'partial' : 'complete' });
  for (const product of ['gairmet', 'sigmet', 'cwa']) {
    const value = input.advisories[product] ?? { ready: false };
    source(`advisory.${product}`, value, INFO_FRESHNESS.advisory, { coverage: value.unresolvedRecords ? 'partial' : 'complete' });
  }
  source('tfrs', input.tfrs, INFO_FRESHNESS.tfrs, { coverage: input.tfrs.unresolvedRecords ? 'partial' : 'complete' });
  const feed = input.notams;
  if (feed.enabled) {
    source('notams', { ready: feed.generation !== null, checkedAt: feed.checkedAt, error: feed.error, nextAttemptAt: feed.nextAttemptAt },
      INFO_FRESHNESS.notams, { valid: (feed.collectionContinuity ?? feed.continuity) === 'complete', coverage: feed.continuity === 'complete' ? 'complete' : 'partial' });
    if ((feed.unresolvedRecords ?? 0) > (feed.blockingRecords ?? feed.unresolvedRecords ?? 0)) {
      warnings.push({ product: 'notams', reason: 'association-metadata', severity: 'warning' });
    }
    const reconciliation = input.notamReconciliation;
    const overdue = !freshAt(feed.fullSyncAt, now, INFO_FRESHNESS.fullSync, 0);
    if (overdue || reconciliation?.error) problems.push({ product: 'notams.reconciliation',
      reason: reconciliation?.error ?? 'full-sync-overdue', severity: 'warning' });
  }
  return { ready: problems.length === 0, state: problems.some(problem => problem.reason === 'unavailable') ? 'unavailable'
    : problems.length ? 'degraded' : 'ready', sources, problems, warnings };
}
