import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isRecord, isSurfaceCatalog, isSurfaceArtifact, isProgsCoverageCatalog, isRadarCatalog,
  isRadarContours, isRadarMotionCatalog, isRadarMotionSnapshot, isAwcAdvisorySnapshot,
  isNotamFeedStatus, isNotamAirportSnapshot, isNotamNavaidSnapshot, isNotamRegionSnapshot, isTafReport, isTfrSnapshot, TFR_STALE_MS, RADAR_MAX_AGE } from '@zlayer/contracts';
import { isNativeManifest } from '../src/layers/weather-awc/grids/native-source';
import { forecastPath, gridKey } from '../src/layers/weather-awc/grids/identity';
import { terrainKey, terrainPath } from '../src/layers/weather-awc/grids/model-terrain';

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

/** Readiness includes saved artifacts and the optional NOTAM feed, not just liveness. */
export async function checkInfoApi(origin: string, notams: 'disabled' | 'staging' | 'production' = 'disabled') {
  let reads = 0;
  function fresh(time: number, maxAge: number, name: string, futureTolerance = 30_000) {
    const now = Date.now();
    assert.ok(time <= now + futureTolerance && now - time < maxAge, `${name}: stale or future timestamp`);
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
  for (const product of ['clouds', 'icing', 'winds'] as const) {
    const saved = await read(`/api/weather/grids/${product}.json`), catalog = saved.json();
    assert.equal(saved.response.headers.get('x-weather-catalog'), 'complete-native-v1');
    assert.ok(isNativeManifest(catalog) && catalog.product === product, `${product}: invalid catalog`);
    assert.equal(catalog.frames.length, { clouds: 19, icing: 1080, winds: 703 }[product]);
    fresh(catalog.checkedAt, 90 * 60_000, `${product} source check`);
    fresh(catalog.runTime, 3 * 3600_000, `${product} model run`, 0);
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
    fresh(catalog.checkedAt, 10 * 60_000, `${product} source check`);
    if (product === 'analysis') fresh(catalog.frames[0]!.validTime, 6 * 3600_000, 'Surface analysis', 0);
    else assert.ok(catalog.frames.some(frame => frame.validTime >= Date.now()), 'Surface forecast horizon has expired');
    for (const reference of catalog.frames) assert.ok(isSurfaceArtifact((await file('/api/weather/progs/', reference)).json()));
  }
  const coverage = (await read('/api/weather/progs/coverage.json')).json(); assert.ok(isProgsCoverageCatalog(coverage));
  fresh(coverage.checkedAt, 10 * 60_000, 'Coverage source check');
  fresh(coverage.frames.find(frame => frame.validTime === frame.chartReferenceTime)!.validTime, 6 * 3600_000, 'Coverage analysis', 0);
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
  for (const product of ['gairmet', 'sigmet', 'cwa']) assert.ok(isAwcAdvisorySnapshot((await read(`/api/weather/advisories/${product}.json`)).json()));
  const reports = (await read('/api/weather/metars.geojson?ids=KSFO')).json(); assert.ok(isRecord(reports) && reports.type === 'FeatureCollection');
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
    assert.equal(feed.environment, notams); assert.equal(feed.state, 'ready'); assert.equal(feed.continuity, 'complete');
    const airport = (await read('/api/notams/airports?faaId=SFO&icaoId=KSFO')).json(); assert.ok(isNotamAirportSnapshot(airport));
    assert.equal(airport.feed.environment, notams); assert.equal(airport.feed.state, 'ready');
    const navaid = (await read('/api/notams/navaids?navaidId=SAU')).json(); assert.ok(isNotamNavaidSnapshot(navaid), 'Invalid navaid snapshot');
    assert.deepEqual(navaid.query, { navaidId: 'SAU' });
    assert.equal(navaid.feed.environment, notams); assert.equal(navaid.feed.state, 'ready');
    const region = (await read('/api/notams/regions?artccId=ZOA')).json(); assert.ok(isNotamRegionSnapshot(region), 'Invalid regional snapshot');
    assert.deepEqual(region.query, { artccId: 'ZOA' });
    assert.equal(region.feed.environment, notams); assert.equal(region.feed.state, 'ready');
  }
  return { origin, checkedAt: new Date().toISOString(), reads, notams, source: health.source, health };
}

if (import.meta.main) {
  try {
    const mode = process.argv[3] ?? 'disabled';
    assert.ok(mode === 'disabled' || mode === 'staging' || mode === 'production', 'Invalid NOTAM mode');
    assert.ok(process.argv[2], 'Supply the info API origin');
    console.log(JSON.stringify(await checkInfoApi(process.argv[2], mode)));
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
