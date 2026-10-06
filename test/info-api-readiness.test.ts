import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RADAR_MOTION_ROOT, type RadarMotionSnapshot, type RadarMotionCatalog } from '@zlayer/contracts';
import { checkInfoApi } from '../tools/check-info-api';
import { modelPath, SOURCE_ROOT, type NativeManifest } from '../src/layers/weather-awc/grids/native-source';
import { digest, type Payload } from '../tools/info-server/upstream';
import { resourceFor } from '../tools/info-server/routes';
import { fixtureWeather } from './fixtures/info-server';
import { advisorySnapshot, WEATHER_NOW } from './fixtures/awc-advisories';
import { radarFixture } from './fixtures/radar';
import { notamSnapshot } from './fixtures/notams';

const HOUR = 3600_000, MINUTE = 60_000;
function shiftRun(manifest: NativeManifest, hours: number) {
  manifest.runTime += hours * HOUR; manifest.generation = `${manifest.product}-${manifest.runTime}`;
  for (const frame of manifest.frames) {
    frame.validTime += hours * HOUR;
    const lead = (frame.validTime - manifest.runTime) / HOUR;
    frame.sources = [modelPath(manifest.product, manifest.runTime, lead),
      ...(manifest.product === 'clouds' ? [] : [modelPath('clouds', manifest.runTime, 0)])].map(path => SOURCE_ROOT + path);
    for (const [field, record] of Object.entries(frame.records)) record.path = modelPath(field === 'terrain' ? 'clouds' : manifest.product,
      manifest.runTime, field === 'terrain' ? 0 : lead);
  }
}

test('deployment readiness requires current weather as well as authenticated saved files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'info-readiness-')), app = await fixtureWeather(directory);
  const responses = new Map<string, Pick<Payload, 'body' | 'headers'>>();
  const json = (path: string, value: unknown) => responses.set(path, { body: Buffer.from(JSON.stringify(value)), headers: {} });
  try {
    for (const product of ['clouds', 'icing', 'winds'] as const) {
      const catalog = await app.processing.catalog(product);
      responses.set(`/api/weather/grids/${product}.json`, { ...catalog, headers: { 'x-weather-catalog': 'complete-native-v1' } });
    }
    await app.warmProgs();
    for (const product of ['analysis', 'forecast', 'coverage']) {
      const path = `/api/weather/progs/${product}.json`, saved = await app.cache.read(resourceFor(path)); assert.ok(saved);
      responses.set(path, saved);
      const catalog = JSON.parse(saved.body.toString()) as { frames: { path?: string; file?: { path: string } }[] };
      for (const frame of catalog.frames) {
        const path = frame.path ?? frame.file?.path;
        if (path) responses.set(`/api/weather/progs/${path}`, (await app.cache.read(resourceFor(`/api/weather/progs/${path}`)))!);
      }
    }
    json('/api/notams/healthz', app.notams.status);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
  const radar = radarFixture(); json('/api/weather/radar/latest.json', radar.catalog);
  for (const [path, body] of radar.files) responses.set(`/api/weather/radar/${path}`, { body, headers: {} });
  const motion: RadarMotionSnapshot = { schemaVersion: 1, scans: [{ site: 'KTLX', observedAt: WEATHER_NOW - MINUTE,
    source: `${RADAR_MOTION_ROOT}SI.ktlx/sn.last`, sourceHash: 'a'.repeat(64), tracks: [] }] };
  const motionBody = Buffer.from(JSON.stringify(motion)), hash = digest(motionBody);
  const motionCatalog: RadarMotionCatalog = { schemaVersion: 1, checkedAt: WEATHER_NOW, unavailable: [],
    files: [{ path: `motion/${hash}.json`, sha256: hash, byteLength: motionBody.length, availableAt: WEATHER_NOW }] };
  json('/api/weather/radar/motion/latest.json', motionCatalog);
  responses.set(`/api/weather/radar/motion/${hash}.json`, { body: motionBody, headers: {} });
  const ready = { ready: true };
  json('/api/weather/healthz', { ok: true, forecasts: { clouds: ready, icing: ready, winds: ready },
    progs: { analysis: ready, forecast: ready }, progsCoverage: ready, radar: ready, radarMotion: ready });
  for (const product of ['gairmet', 'sigmet', 'cwa'] as const) json(`/api/weather/advisories/${product}.json`, advisorySnapshot(product));
  json('/api/weather/metars.geojson?ids=KSFO', { type: 'FeatureCollection', features: [] });
  json('/api/weather/tafs.json?ids=KSFO', []);
  json('/api/notams/tfrs', { schemaVersion: 1, source: 'FAA-TFR', checkedAt: WEATHER_NOW, notices: [], issues: [] });
  json('/api/notams/airports?faaId=SFO&icaoId=KSFO', { error: 'disabled' });
  json('/api/notams/navaids?navaidId=SAU', { error: 'disabled' });
  json('/api/notams/regions?artccId=ZOA', { error: 'disabled' });

  type Edit = { path: string; update: (value: any) => void; error: RegExp };
  const edits: Edit[] = [
    ...['clouds', 'icing', 'winds'].flatMap(product => [
      { path: `/api/weather/grids/${product}.json`, update: (v: NativeManifest) => { v.checkedAt = v.publishedAt = WEATHER_NOW - 91 * MINUTE; shiftRun(v, -1); }, error: /source check: stale/ },
      { path: `/api/weather/grids/${product}.json`, update: (v: NativeManifest) => { v.checkedAt = v.publishedAt = WEATHER_NOW + MINUTE; }, error: /source check: stale or future/ },
      { path: `/api/weather/grids/${product}.json`, update: (v: NativeManifest) => shiftRun(v, -24), error: /model run: stale/ },
    ]),
    ...['analysis', 'forecast', 'coverage'].flatMap(product => [
      { path: `/api/weather/progs/${product}.json`, update: (v: any) => { v.checkedAt -= 11 * MINUTE; }, error: /source check: stale/ },
      { path: `/api/weather/progs/${product}.json`, update: (v: any) => { v.checkedAt += MINUTE; v.frames.forEach((f: any) => { f.checkedAt += MINUTE; }); }, error: /source check: stale or future/ },
    ]),
    { path: '/api/weather/progs/analysis.json', update: v => { v.frames[0].validTime -= 6 * HOUR; v.frames[0].referenceTime -= 6 * HOUR; }, error: /Surface analysis: stale/ },
    { path: '/api/weather/radar/latest.json', update: v => { v.checkedAt -= 16 * MINUTE; v.files.forEach((f: any) => {
      f.observedAt -= 16 * MINUTE; f.path = `${f.site}/${f.observedAt}-${f.sha256}.json`;
    }); }, error: /Radar source check: stale/ },
    ...[-16 * MINUTE, 3 * MINUTE].map(delta => ({ path: '/api/weather/radar/latest.json', update: (v: any) => {
      const f = v.files.find((f: any) => f.site === 'CONUS'); f.observedAt += delta; f.path = `${f.site}/${f.observedAt}-${f.sha256}.json`;
    }, error: /National radar observation: stale or future/ })),
    { path: '/api/weather/radar/motion/latest.json', update: v => { v.checkedAt -= 16 * MINUTE; v.files[0].availableAt -= 16 * MINUTE; }, error: /Storm motion source check: stale/ },
    { path: '/api/weather/radar/motion/latest.json', update: v => { v.files[0].availableAt -= 16 * MINUTE; }, error: /Storm motion collection: stale/ },
    { path: '/api/weather/radar/motion/latest.json', update: v => { v.files = []; }, error: /Current storm motion snapshot is missing/ },
  ];
  const cases = [{ name: 'current weather, including a quiet storm scan', edit: undefined },
    ...edits.map((edit, index) => ({ name: `${index}: ${edit.path} ${edit.error.source}`, edit }))];
  for (const { name, edit } of cases) await t.test(name, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: WEATHER_NOW });
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input)), path = url.pathname + url.search;
      const artifact = /^\/api\/weather\/grids\/.+-([a-f0-9]{64})\.zw[pt]\.gz$/.exec(path);
      // Numeric format/conversion has separate integration coverage. This check
      // exercises the deployment probe's transport, identity and freshness gates.
      const saved = responses.get(path) ?? (artifact ? { body: Buffer.from('prepared grid'), headers: { 'x-weather-artifact': artifact[1]! } } : undefined);
      assert.ok(saved, `Unexpected readiness request: ${path}`);
      let body = saved.body;
      if (edit?.path === path) { const value = JSON.parse(body.toString()); edit.update(value); body = Buffer.from(JSON.stringify(value)); }
      return new Response(Uint8Array.from(body), { status: /^\/api\/notams\/(airports|navaids|regions)/.test(path) ? 503 : 200,
        headers: { ...saved.headers, 'cache-control': 'no-store', 'x-weather-sha256': digest(body) } });
    });
    if (edit) await assert.rejects(checkInfoApi('https://info.test'), edit.error);
    else assert.ok((await checkInfoApi('https://info.test')).reads > 25);
  });
  await t.test('recent collection cannot freshen old storm observations', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: WEATHER_NOW });
    const stale = structuredClone(motion); stale.scans[0]!.observedAt -= 16 * MINUTE;
    const body = Buffer.from(JSON.stringify(stale)), sha256 = digest(body), file = { ...motionCatalog.files[0]!, path: `motion/${sha256}.json`, sha256, byteLength: body.length };
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input)), path = url.pathname + url.search;
      const artifact = /^\/api\/weather\/grids\/.+-([a-f0-9]{64})\.zw[pt]\.gz$/.exec(path);
      const saved = path === '/api/weather/radar/motion/latest.json' ? { body: Buffer.from(JSON.stringify({ ...motionCatalog, files: [file] })), headers: {} }
        : path === `/api/weather/radar/${file.path}` ? { body, headers: {} }
          : responses.get(path) ?? { body: Buffer.from('prepared grid'), headers: { 'x-weather-artifact': artifact?.[1] ?? '' } };
      return new Response(Uint8Array.from(saved.body), { headers: { ...saved.headers, 'cache-control': 'no-store', 'x-weather-sha256': digest(saved.body) } });
    });
    await assert.rejects(checkInfoApi('https://info.test'), /No current storm motion observations/);
  });
  for (const failure of [undefined, 'missing-route', 'wrong-scope', 'wrong-station', 'old-full-sync', 'source-issue'] as const) await t.test(`navaid route readiness: ${failure ?? 'ready'}`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: WEATHER_NOW });
    const airport = notamSnapshot([], { query: { faaId: 'SFO', icaoId: 'KSFO' } });
    airport.feed.checkedAt = airport.feed.watermark = WEATHER_NOW;
    airport.feed.fullSyncAt = WEATHER_NOW - (failure === 'old-full-sync' ? 25 * HOUR : 0);
    if (failure === 'source-issue') Object.assign(airport.feed, { state: 'degraded', error: 'unresolved-records',
      unresolvedRecords: 1, recordCount: 1, continuity: 'incomplete', collectionContinuity: 'complete', unscopedRecords: 0 });
    const navaid = { ...airport, scope: 'navaid-location', associationCoverage: 'complete', query: { navaidId: 'SAU' } };
    const region = { ...airport, scope: 'region-location', associationCoverage: 'incomplete', query: { artccId: 'ZOA' } };
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input)), path = url.pathname + url.search;
      const artifact = /^\/api\/weather\/grids\/.+-([a-f0-9]{64})\.zw[pt]\.gz$/.exec(path);
      const saved = responses.get(path) ?? (artifact ? { body: Buffer.from('prepared grid'), headers: { 'x-weather-artifact': artifact[1]! } } : undefined);
      assert.ok(saved, `Unexpected readiness request: ${path}`);
      const value = path === '/api/notams/healthz' ? airport.feed
        : path.startsWith('/api/notams/airports') ? airport
          : path.startsWith('/api/notams/navaids') ? failure === 'wrong-scope' ? airport
            : failure === 'wrong-station' ? { ...navaid, query: { navaidId: 'SFO' } } : navaid
              : path.startsWith('/api/notams/regions') ? region : undefined;
      const body = value ? Buffer.from(JSON.stringify(value)) : saved.body;
      return new Response(Uint8Array.from(body), { status: failure === 'missing-route' && path.startsWith('/api/notams/navaids') ? 404 : 200,
        headers: { ...saved.headers, 'cache-control': 'no-store', 'x-weather-sha256': digest(body) } });
    });
    if (failure) await assert.rejects(checkInfoApi('https://info.test', 'staging'), failure === 'missing-route' ? /HTTP 404/
      : failure === 'wrong-scope' ? /Invalid navaid snapshot/ : failure === 'old-full-sync' ? /NOTAM full synchronization/
        : failure === 'source-issue' ? /Unexpected unresolved/ : /SAU/);
    else assert.ok((await checkInfoApi('https://info.test', 'staging')).reads > 25);
    if (failure === 'old-full-sync') assert.deepEqual((await checkInfoApi('https://info.test', 'staging',
      { allowOverdueFullSync: true })).warnings, ['full-sync-overdue'], 'an explicit rollout exception remains visible');
    if (failure === 'source-issue') assert.deepEqual((await checkInfoApi('https://info.test', 'staging',
      { maxUnresolvedNotams: 1 })).warnings, ['unresolved-notam-records:1']);
  });
});
