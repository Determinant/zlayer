import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isRecord, isSurfaceCatalog, isSurfaceArtifact, isProgsCoverageCatalog, isRadarCatalog,
  isRadarContours, isRadarMotionCatalog, isRadarMotionSnapshot, isAwcAdvisorySnapshot,
  isNotamFeedStatus, isNotamAirportSnapshot, isNotamNavaidSnapshot, isNotamRegionSnapshot, isMetarFeatureCollection, isTafReport, isTfrSnapshot, TFR_STALE_MS, RADAR_MAX_AGE } from '@zlayer/contracts';
import { isNativeManifest } from '../src/layers/weather-awc/grids/native-source';
import { forecastPath, gridKey } from '../src/layers/weather-awc/grids/identity';
import { terrainKey, terrainPath } from '../src/layers/weather-awc/grids/model-terrain';
import { INFO_FRESHNESS, freshAt } from './info-server/health';

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

/** Readiness includes saved artifacts and the optional NOTAM feed, not just liveness. */
export async function checkInfoApi(origin: string, notams: 'disabled' | 'staging' | 'production' = 'disabled',
  options: { allowOverdueFullSync?: boolean; maxUnresolvedNotams?: number } = {}) {
  const warnings: string[] = [];
  const maxIssues = options.maxUnresolvedNotams ?? 0;
  assert.ok(Number.isInteger(maxIssues) && maxIssues >= 0 && maxIssues <= 150000, 'Invalid source-issue allowance');
  function checkFeed(feed: import('@zlayer/contracts').NotamFeedStatus) {
    assert.equal(feed.environment, notams);
    assert.equal(feed.collectionContinuity ?? feed.continuity, 'complete');
    const issues = feed.unresolvedRecords ?? 0;
    assert.ok(issues <= maxIssues, 'Unexpected unresolved NOTAM source records');
    assert.equal(feed.state, issues ? 'degraded' : 'ready');
    assert.equal(feed.error, issues ? 'unresolved-records' : null);
    fresh(feed.checkedAt!, INFO_FRESHNESS.notams, 'NOTAM source check', 0);
  }
  let reads = 0;
  function fresh(time: number, maxAge: number, name: string, futureTolerance = 30_000) {
    const now = Date.now();
    assert.ok(freshAt(time, now, maxAge, futureTolerance), `${name}: stale or future timestamp`);
  }
  async function read(path: string, status = 200) {
    const response = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(30_000), cache: 'no-store' });
    assert.equal(response.status, status, `${path}: HTTP ${response.status}`);
    assert.equal(response.headers.get('cache-control'), 'no-store', `${path}: cache policy`);
    const chunks: Buffer[] = []; let size = 0;
    if (response.body) for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length; assert.ok(size <= 16 * 1024 * 1024, `${path}: response exceeds its bound`); chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks), digest = response.headers.get('x-weather-sha256');
    if (digest) assert.equal(sha256(body), digest, `${path}: checksum`);
    reads++;
    return { response, body, json: (): unknown => JSON.parse(body.toString()) };
  }
  async function file(root: string, file: { path: string; byteLength: number; sha256: string }) {
    const saved = await read(root + file.path);
    assert.equal(saved.body.length, file.byteLength, `${file.path}: byte length`);
    assert.equal(sha256(saved.body), file.sha256, `${file.path}: catalog checksum`);
    return saved;
  }
  const health = (await read('/api/weather/healthz')).json();
  assert.ok(isRecord(health) && health.ok === true && isRecord(health.forecasts) && isRecord(health.progs));
  for (const group of [health.forecasts, health.progs, { coverage: health.progsCoverage, radar: health.radar, motion: health.radarMotion }]) {
    for (const [name, state] of Object.entries(group)) assert.ok(isRecord(state) && state.ready === true, `${name}: not ready`);
  }
  assert.ok(isRecord(health.readiness) && isRecord(health.readiness.sources), 'Weather readiness status missing');
  for (const name of ['clouds', 'icing', 'winds', 'progs.analysis', 'progs.forecast', 'progs.coverage', 'radar', 'radarMotion',
    'advisory.gairmet', 'advisory.sigmet', 'advisory.cwa']) {
    const state: unknown = health.readiness.sources[name];
    assert.ok(isRecord(state), `${name}: readiness status missing`);
    assert.equal(state.available, true, `${name}: unavailable`);
    assert.equal(state.fresh, true, `${name}: stale or future source`);
    assert.equal(state.error, null, `${name}: source refresh failed`);
  }
  for (const product of ['clouds', 'icing', 'winds'] as const) {
    const saved = await read(`/api/weather/grids/${product}.json`), catalog = saved.json();
    assert.equal(saved.response.headers.get('x-weather-catalog'), 'complete-native-v1');
    assert.ok(isNativeManifest(catalog) && catalog.product === product, `${product}: invalid catalog`);
    assert.equal(catalog.frames.length, { clouds: 19, icing: 1080, winds: 703 }[product]);
    fresh(catalog.checkedAt, INFO_FRESHNESS.gridCheck, `${product} source check`);
    fresh(catalog.runTime, INFO_FRESHNESS.modelRun, `${product} model run`, 0);
    const frame = catalog.frames.find(f => f.validTime >= Date.now());
    assert.ok(frame, `${product}: forecast horizon has expired`);
    const identity = sha256(gridKey(catalog, frame));
    const artifact = await read('/api/weather/grids/' + forecastPath(catalog, frame, identity));
    assert.equal(artifact.response.headers.get('x-weather-artifact'), identity);
    assert.ok(artifact.body.length > 0 && artifact.response.headers.has('x-weather-sha256'));
    if (product === 'winds') {
      const identity = sha256(terrainKey(catalog, catalog.frames[0]!));
      const terrain = await read('/api/weather/grids/' + terrainPath(catalog, identity));
      assert.equal(terrain.response.headers.get('x-weather-artifact'), identity);
    }
  }
  for (const product of ['analysis', 'forecast'] as const) {
    const catalog = (await read(`/api/weather/progs/${product}.json`)).json();
    assert.ok(isSurfaceCatalog(catalog) && catalog.product === product);
    fresh(catalog.checkedAt, INFO_FRESHNESS.charts, `${product} source check`);
    if (product === 'analysis') fresh(catalog.frames[0]!.validTime, INFO_FRESHNESS.analysis, 'Surface analysis', 0);
    else assert.ok(catalog.frames.some(frame => frame.validTime >= Date.now()), 'Surface forecast horizon has expired');
    for (const reference of catalog.frames) assert.ok(isSurfaceArtifact((await file('/api/weather/progs/', reference)).json()));
  }
  const coverage = (await read('/api/weather/progs/coverage.json')).json(); assert.ok(isProgsCoverageCatalog(coverage));
  fresh(coverage.checkedAt, INFO_FRESHNESS.charts, 'Coverage source check');
  fresh(coverage.frames.find(frame => frame.validTime === frame.chartReferenceTime)!.validTime, INFO_FRESHNESS.analysis, 'Coverage analysis', 0);
  assert.ok(coverage.frames.some(frame => frame.validTime >= Date.now()), 'Coverage forecast horizon has expired');
  const image = coverage.frames.find(frame => frame.file)?.file; assert.ok(image, 'No available coverage image');
  const png = await file('/api/weather/progs/', image); assert.equal(png.body.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const radar = (await read('/api/weather/radar/latest.json')).json(); assert.ok(isRadarCatalog(radar));
  fresh(radar.checkedAt, RADAR_MAX_AGE, 'Radar source check');
  const national = radar.files.find(f => f.site === 'CONUS'); assert.ok(national, 'National radar is missing');
  fresh(national.observedAt, RADAR_MAX_AGE, 'National radar observation', 0);
  assert.ok(isRadarContours((await file('/api/weather/radar/', national)).json()));
  const motion = (await read('/api/weather/radar/motion/latest.json')).json(); assert.ok(isRadarMotionCatalog(motion));
  fresh(motion.checkedAt, RADAR_MAX_AGE, 'Storm motion source check');
  const latestMotion = motion.files.at(-1); assert.ok(latestMotion, 'Current storm motion snapshot is missing');
  fresh(latestMotion.availableAt, RADAR_MAX_AGE, 'Storm motion collection', 0);
  const tracks = (await file('/api/weather/radar/', latestMotion)).json(); assert.ok(isRadarMotionSnapshot(tracks));
  assert.ok(tracks.scans.some(scan => scan.observedAt <= Date.now() && Date.now() - scan.observedAt < RADAR_MAX_AGE), 'No current storm motion observations');
  for (const product of ['gairmet', 'sigmet', 'cwa']) {
    const snapshot = (await read(`/api/weather/advisories/${product}.json`)).json();
    assert.ok(isAwcAdvisorySnapshot(snapshot) && snapshot.product === product, `${product}: invalid advisory snapshot`);
    fresh(snapshot.checkedAt, INFO_FRESHNESS.advisory, `${product} source check`);
  }
  const reports = (await read('/api/weather/metars.geojson?ids=KSFO')).json(); assert.ok(isMetarFeatureCollection(reports));
  const tafs = (await read('/api/weather/tafs.json?ids=KSFO')).json(); assert.ok(Array.isArray(tafs) && tafs.every(isTafReport));
  const tfrs = (await read('/api/notams/tfrs')).json();
  assert.ok(isTfrSnapshot(tfrs) && !tfrs.error, 'TFR snapshot unavailable or degraded');
  fresh(tfrs.checkedAt, TFR_STALE_MS, 'TFR source check');
  const feed = (await read('/api/notams/healthz')).json(); assert.ok(isNotamFeedStatus(feed));
  if (notams === 'disabled') {
    assert.equal(feed.state, 'disabled'); assert.equal(feed.enabled, false);
    await read('/api/notams/airports?faaId=SFO&icaoId=KSFO', 503);
    await read('/api/notams/navaids?navaidId=SAU', 503);
    await read('/api/notams/regions?artccId=ZOA', 503);
  } else {
    checkFeed(feed);
    assert.ok(isRecord(health.notamReconciliation), 'NOTAM reconciliation status missing');
    assert.equal(health.notamReconciliation.error, null, 'NOTAM reconciliation failed');
    if (feed.unresolvedRecords) warnings.push(`unresolved-notam-records:${feed.unresolvedRecords}`);
    assert.ok(feed.fullSyncAt !== null);
    if (options.allowOverdueFullSync && feed.fullSyncAt <= Date.now() && !freshAt(feed.fullSyncAt, Date.now(), INFO_FRESHNESS.fullSync, 0)) {
      warnings.push('full-sync-overdue');
    } else fresh(feed.fullSyncAt, INFO_FRESHNESS.fullSync, 'NOTAM full synchronization', 0);
    const airport = (await read('/api/notams/airports?faaId=SFO&icaoId=KSFO')).json(); assert.ok(isNotamAirportSnapshot(airport));
    checkFeed(airport.feed);
    const navaid = (await read('/api/notams/navaids?navaidId=SAU')).json(); assert.ok(isNotamNavaidSnapshot(navaid), 'Invalid navaid snapshot');
    assert.deepEqual(navaid.query, { navaidId: 'SAU' });
    checkFeed(navaid.feed);
    const region = (await read('/api/notams/regions?artccId=ZOA')).json(); assert.ok(isNotamRegionSnapshot(region), 'Invalid regional snapshot');
    assert.deepEqual(region.query, { artccId: 'ZOA' });
    checkFeed(region.feed);
  }
  return { origin, checkedAt: new Date().toISOString(), reads, notams, warnings, source: health.source, health };
}

if (import.meta.main) {
  try {
    const mode = process.argv[3] ?? 'disabled';
    assert.ok(mode === 'disabled' || mode === 'staging' || mode === 'production', 'Invalid NOTAM mode');
    assert.ok(process.argv[2], 'Supply the info API origin');
    const args = process.argv.slice(4);
    assert.ok(args.every(arg => arg === '--allow-overdue-full-sync' || /^--allow-unresolved-notams=\d+$/.test(arg)), 'Unknown probe option');
    console.log(JSON.stringify(await checkInfoApi(process.argv[2], mode, { allowOverdueFullSync: args.includes('--allow-overdue-full-sync'),
      maxUnresolvedNotams: Number(args.find(arg => arg.startsWith('--allow-unresolved-notams='))?.split('=')[1] ?? 0) })));
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
