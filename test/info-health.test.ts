import assert from 'node:assert/strict';
import test from 'node:test';
import { assessInfoHealth, freshAt, INFO_FRESHNESS, type InfoHealthInput } from '../tools/info-server/health';
import { SourceDiagnostics, sourceFailureCode } from '../tools/info-server/diagnostics';
import { DurationStats, InfoMetrics } from '../tools/info-server/metrics';
import { HttpError } from '../tools/info-server/routes';
import { WeatherSourceError } from '../tools/info-server/source-error';
import { notamSnapshot, NOTAM_NOW } from './fixtures/notams';

function healthy(): InfoHealthInput {
  const published = { ready: true, checkedAt: NOTAM_NOW };
  const forecast = { ...published, runTime: NOTAM_NOW - 3600_000, validThrough: NOTAM_NOW + 3600_000 };
  return { forecasts: { clouds: forecast, icing: forecast, winds: forecast },
    progs: { analysis: { ...published, validTimes: [NOTAM_NOW] }, forecast: { ...published, validTimes: [NOTAM_NOW + 3600_000] } },
    progsCoverage: { ...published, analysisTime: NOTAM_NOW, validTimes: [NOTAM_NOW, NOTAM_NOW + 3600_000] },
    radar: { ...published, observedAt: NOTAM_NOW }, radarMotion: { ...published, newestObservedAt: NOTAM_NOW, unavailable: 0 },
    advisories: { gairmet: published, sigmet: published, cwa: published }, notams: notamSnapshot().feed,
    tfrs: { ...published, unresolvedRecords: 0 }, notamReconciliation: { state: 'current', error: null, nextAttemptAt: NOTAM_NOW + 86400_000 } };
}
test('health distinguishes expected coverage gaps from source freshness and availability', () => {
  const value = healthy();
  value.radar.unavailable = ['TBWI', 'TFLL', 'TPIT', 'TSDF', 'TTPA', 'TTUL'];
  value.radarMotion.unavailable = 85;
  value.progsCoverage.unavailableTimes = [NOTAM_NOW + 168 * 3600_000];
  const status = assessInfoHealth(value, NOTAM_NOW);
  assert.equal(status.state, 'ready'); assert.equal(status.ready, true);
  for (const key of ['radar', 'radarMotion', 'progs.coverage']) assert.equal(status.sources[key]?.coverage, 'partial');
  value.forecasts.clouds = { ...value.forecasts.clouds!, checkedAt: NOTAM_NOW - INFO_FRESHNESS.gridCheck };
  value.radar.observedAt = NOTAM_NOW - INFO_FRESHNESS.radar;
  value.radarMotion.newestObservedAt = null;
  const stale = assessInfoHealth(value, NOTAM_NOW);
  assert.equal(stale.state, 'degraded'); assert.equal(stale.sources.radar?.available, true); assert.equal(stale.sources.radar?.fresh, false);
  assert.deepEqual(stale.problems.map(p => p.product), ['clouds', 'radar', 'radarMotion']);
  value.radar.ready = false;
  assert.equal(assessInfoHealth(value, NOTAM_NOW).state, 'unavailable');
  const missing = healthy(); delete missing.forecasts.winds;
  assert.equal(assessInfoHealth(missing, NOTAM_NOW).sources.winds?.available, false);
});
test('coverage readiness separates unpublished forecast stops from missing images and expired horizons', () => {
  const value = healthy();
  value.progsCoverage.validTimes = [NOTAM_NOW - 3600_000];
  value.progsCoverage.analysisTime = NOTAM_NOW - 3600_000;
  value.progsCoverage.unavailableTimes = [NOTAM_NOW + 3600_000];
  const status = assessInfoHealth(value, NOTAM_NOW);
  assert.equal(status.ready, true, 'a current analysis image is enough when forecast images are unpublished');
  assert.equal(status.sources['progs.coverage']?.coverage, 'partial');
  const cases: [Partial<InfoHealthInput['progsCoverage']>, 'stale' | 'unavailable'][] = [
    [{ checkedAt: NOTAM_NOW - INFO_FRESHNESS.charts }, 'stale'],
    [{ analysisTime: NOTAM_NOW - INFO_FRESHNESS.analysis }, 'stale'],
    [{ analysisTime: NOTAM_NOW + 60_000 }, 'stale'],
    [{ analysisTime: undefined }, 'stale'],
    [{ unavailableTimes: [NOTAM_NOW - 1] }, 'stale'],
    [{ validTimes: [] }, 'unavailable'],
    [{ ready: false }, 'unavailable'],
  ];
  for (const [patch, reason] of cases) {
    const result = assessInfoHealth({ ...value, progsCoverage: { ...value.progsCoverage, ...patch } }, NOTAM_NOW);
    assert.equal(result.ready, false);
    assert.deepEqual(result.problems, [{ product: 'progs.coverage', reason, severity: 'error' }]);
  }
  value.progsCoverage.validTimes!.unshift(NOTAM_NOW - 7 * 3600_000);
  assert.equal(assessInfoHealth(value, NOTAM_NOW).ready, true, 'an older forecast stop cannot stand in for the explicit analysis time');
});
test('fresh deltas and available weather cannot hide an overdue or failed full sync', () => {
  const value = healthy(); value.notams.fullSyncAt = NOTAM_NOW - INFO_FRESHNESS.fullSync;
  let status = assessInfoHealth(value, NOTAM_NOW);
  assert.equal(status.sources.notams?.fresh, true);
  assert.deepEqual(status.problems, [{ product: 'notams.reconciliation', reason: 'full-sync-overdue', severity: 'warning' }]);
  value.notamReconciliation!.error = 'source-http-502';
  status = assessInfoHealth(value, NOTAM_NOW);
  assert.equal(status.problems[0]?.reason, 'source-http-502');
  value.notams.enabled = false;
  assert.equal(assessInfoHealth(value, NOTAM_NOW).ready, true);
  assert.equal(freshAt(NOTAM_NOW + 1, NOTAM_NOW, 100, 0), false);
  assert.equal(freshAt(NaN, NOTAM_NOW, 100), false);
});
test('source diagnostics bound identities and log only transitions and recovery', () => {
  let now = 1000; const logs: string[] = [], diagnostics = new SourceDiagnostics(2, () => now, line => logs.push(line));
  diagnostics.failed('KAAA', 'stale-source'); now++;
  diagnostics.failed('KAAA', 'stale-source'); diagnostics.failed('KBBB', 'invalid-source');
  diagnostics.failed('KCCC', 'processing-failed');
  assert.equal(logs.length, 2); assert.equal(diagnostics.status.sources.KAAA?.since, 1000);
  assert.equal(diagnostics.status.sources.KAAA?.count, 2); assert.equal(Object.keys(diagnostics.status.sources).length, 2);
  diagnostics.failed('KAAA', 'upstream-unavailable'); diagnostics.recovered('KAAA'); diagnostics.recovered('KAAA');
  assert.equal(logs.length, 4); diagnostics.retain(new Set(['KAAA'])); assert.deepEqual(diagnostics.status.counts, {});
  assert.equal(sourceFailureCode(new WeatherSourceError('old', 'stale-source')), 'stale-source');
  assert.equal(sourceFailureCode(new HttpError(503, 'backoff')), 'upstream-backoff');
  assert.equal(sourceFailureCode(new HttpError(507, 'full')), 'storage-unavailable');
});
test('bounded duration metrics retain failures, active work and approximate percentile limits', async () => {
  let now = 0; const stats = new DurationStats(() => now);
  const first = stats.start(); now = 7; first(); first(true);
  const second = stats.start(); now = 107; second(true);
  const active = stats.start();
  assert.deepEqual(stats.status, { count: 2, failed: 1, active: 1, lastMs: 100, maxMs: 100, meanMs: 53.5, p50Ms: 10, p95Ms: 100, p99Ms: 100 });
  active();
  const metrics = new InfoMetrics();
  try {
    await assert.rejects(metrics.measure('forecast.clouds', async () => { throw new Error('fixture'); }), /fixture/);
    assert.throws(() => metrics.measureSync('notams.merge', () => { throw new Error('fixture'); }), /fixture/);
    assert.equal(metrics.status.operations['forecast.clouds']!.failed, 1);
    assert.equal(metrics.status.operations['notams.merge']!.active, 0);
    assert.ok(metrics.status.memory.peakRssBytes >= metrics.status.memory.rssBytes * 0.9);
  } finally { metrics.close(); }
});
