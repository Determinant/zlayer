import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { isNativeManifest, type NativeManifest } from '../src/layers/weather-awc/grids/native-source';
import { createInfoServer } from './info-server/server';
import { NotamStore } from './info-server/notams/store';
import { readArchivedNotamBulk } from './info-server/notams/bulk-source';
import { forecastResource, terrainResource } from './info-server/processing';
import { sourceBlocks, sourceRecordKey } from './info-server/source-records';
import { resourceFor, type Resource } from './info-server/weather-resources';
import { workerJob, workerModule } from './info-server/worker-job';

// The private snapshot procedure creates this marker only after copying immutable
// weather bytes and durable NMS state. Never point this tool at live directories.
const [directory, output, secondsText = '600'] = process.argv.slice(2);
const seconds = Number(secondsText);
if (!directory || !output || !Number.isInteger(seconds) || seconds < 60 || seconds > 1800)
  throw new Error('Usage: replay-info-capacity ISOLATED_COPY OUTPUT.json [SECONDS=600]');
const root = resolve(directory), marker = JSON.parse(await readFile(join(root, '.capacity-replay.json'), 'utf8'));
assert.equal(marker.purpose, 'isolated-info-capacity');
assert.ok(Number.isSafeInteger(marker.capturedAt) && marker.capturedAt > 0);
assert.ok(Number.isSafeInteger(marker.maxBytes) && marker.maxBytes > 0);
assert.ok(Number.isSafeInteger(marker.maxEntries) && marker.maxEntries > 0);
await mkdir(join(root, 'replay')); // Refuse reuse of a previous workload's state.
let now: number = marker.capturedAt, externalRequests = 0, fixtureRequests = 0;
const originalState = join(root, 'notams', 'production'), budgetPath = join(originalState, 'budget.json');
const originalBudget = await readFile(budgetPath), fixtureRoot = join(root, 'replay', 'notams');
// New fixture state uses actual records but an invented due schedule. The copied
// production admission journal is never reset or handed to a collector. Keep
// these stores scoped so the fixture setup does not retain another full dataset.
async function seedFixture() {
  const originalStore = new NotamStore(originalState, 'production', () => now);
  let saved;
  try { saved = await originalStore.restore(); assert.ok(saved?.complete); }
  finally { await originalStore.close(); }
  const seed = new NotamStore(join(fixtureRoot, 'staging'), 'staging', () => now);
  try {
    await seed.restore(); now -= 86_400_000; await seed.admission.reserve('bulk'); now += 86_400_000;
    await seed.publish({ ...saved, environment: 'staging', checkedAt: now - 180_000, watermark: now - 180_000,
      baselineAt: now - 86_400_000, fullSyncAt: now - 86_400_000 });
  } finally { await seed.close(); }
  await cp(join(root, 'notams', 'tfrs'), join(fixtureRoot, 'tfrs'), { recursive: true, errorOnExist: true, force: false });
  return saved.generation;
}
const sourceGeneration = await seedFixture();
const archiveDirectory = join(originalState, 'bulk-archive');
const archiveName = (await readdir(archiveDirectory)).filter(name => /^\d+-[a-f0-9]{64}\.json$/.test(name))
  .sort((a, b) => Number(b.split('-')[0]) - Number(a.split('-')[0]))[0];
assert.ok(archiveName, 'Retained complete bulk input required');
const archive = await readArchivedNotamBulk(join(archiveDirectory, archiveName));
const bulkBytes = await readFile(archive.path);

const weather = join(root, 'weather');
const radarInputs: { resource: Resource; checkedAt: number }[] = [];
for (const name of await readdir(weather)) {
  if (!/^[a-f0-9-]+\.cache$/.test(name)) continue;
  const file = await open(join(weather, name), 'r');
  try {
    const prefix = Buffer.alloc(4); await file.read(prefix, 0, 4, 0);
    const size = prefix.readUInt32BE(); assert.ok(size <= 16_384);
    const bytes = Buffer.alloc(size); await file.read(bytes, 0, size, 4);
    const metadata = JSON.parse(bytes.toString());
    if (metadata.resource.kind === 'radar-data' && metadata.resource.url.includes('MRMS')) radarInputs.push(metadata);
  } finally { await file.close(); }
}
const app = await createInfoServer({ directory: weather, maxBytes: marker.maxBytes, maxEntries: marker.maxEntries,
  startUpdates: false, now: () => now, notamWait: async ms => { now += ms; },
  notams: { enabled: true, environment: 'staging', directory: fixtureRoot, credentials: { clientId: 'offline', clientSecret: 'offline' } },
  fetch: async input => {
    const url = new URL(String(input));
    if (url.hostname !== 'api-staging.cgifederal-aim.com') { externalRequests++; throw new Error('Offline source cache miss: ' + url.pathname); }
    fixtureRequests++; now += 1001;
    if (url.pathname.endsWith('/auth/token')) return Response.json({ access_token: 'offline', expires_in: '1799', token_type: 'BearerToken' });
    if (url.pathname.endsWith('/il')) return Response.json({ status: 'Success', data: { url: '/v1/content/offline' } });
    if (url.pathname.endsWith('/content/offline')) return new Response(bulkBytes);
    if (url.pathname.endsWith('/notams')) return Response.json({ status: 'Success', data: { aixm: [] } });
    externalRequests++; throw new Error('Unexpected offline source request');
  },
});
const abort = new AbortController(), counts = { forecasts: 0, radar: 0, bulk: 0 }, started = performance.now();
let sampler: Worker | undefined, peakRssBytes = 0;
const memory = setInterval(() => { peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss); }, 1000).unref();
const jobs: { manifest: NativeManifest; frame: NativeManifest['frames'][number]; terrain: boolean }[] = [];
const sources: { product: string; catalogSha256: string; frames: number[] }[] = [];
try {
  await app.notams.settled();
  for (const product of ['winds', 'icing', 'clouds'] as const) {
    const payload = await app.cache.read(resourceFor(`/api/weather/grids/${product}.json`)); assert.ok(payload);
    const manifest: unknown = JSON.parse(payload.body.toString()); assert.ok(isNativeManifest(manifest));
    const blocks = sourceBlocks(manifest.frames.flatMap(frame => Object.values(frame.records)));
    const frames = manifest.frames.filter(frame => Object.values(frame.records).every(record => {
      const block = blocks.get(sourceRecordKey(record)); return block && app.cache.has(block.resource);
    }));
    assert.ok(frames.length, `No complete retained ${product} source frame`);
    const selected = [...new Set([frames[0]!, frames.at(-1)!])];
    sources.push({ product, catalogSha256: payload.sha256, frames: selected.map(frame => frame.validTime) });
    for (const frame of selected) jobs.push({ manifest, frame, terrain: false });
    if (product === 'winds') jobs.push({ manifest, frame: selected[0]!, terrain: true });
  }
  const radar = radarInputs.sort((a, b) => b.checkedAt - a.checkedAt).find(input => app.cache.has(input.resource));
  assert.ok(radar, 'Retained full CONUS MRMS source required');
  const radarPayload = await app.cache.read(radar.resource); assert.ok(radarPayload);
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  // Independent worker timers observe main-loop stalls. No network endpoint
  // except this disposable loopback server is reachable by the sampler.
  sampler = new Worker(`const {parentPort,workerData}=require('node:worker_threads');
    (async()=>{const durations=[];let failures=0;const end=Date.now()+workerData.ms;
      while(Date.now()<end){const start=performance.now();try{
        const response=await fetch(workerData.url+(durations.length%2?'/api/notams/airports?faaId=EWR':'/api/weather/healthz'),{signal:AbortSignal.timeout(10000)});
        await response.arrayBuffer();if(!response.ok)failures++;
      }catch{failures++;}durations.push(performance.now()-start);await new Promise(r=>setTimeout(r,100));}
      durations.sort((a,b)=>a-b);const q=p=>durations[Math.min(durations.length-1,Math.floor(durations.length*p))];
      parentPort.postMessage({reads:durations.length,failures,p50Ms:q(.5),p95Ms:q(.95),p99Ms:q(.99),maxMs:q(1)});
    })().catch(error=>{throw error});`, { eval: true, workerData: { url: `http://127.0.0.1:${address.port}`, ms: seconds * 1000 } });
  const samples = new Promise<Record<string, number>>((resolve, reject) => {
    sampler!.once('message', resolve); sampler!.once('error', reject);
    sampler!.once('exit', code => { if (code) reject(new Error(`Sampler exited ${code}`)); });
  });
  void samples.catch(() => {});
  const finishAt = performance.now() + seconds * 1000;
  const forecasts = (async () => {
    do { await Promise.all(jobs.map(async ({ manifest, frame, terrain }) => {
      const payload = await app.processing.forecast(manifest, frame, terrain);
      await app.cache.put(terrain ? terrainResource(manifest, frame) : forecastResource(manifest, frame), payload); counts.forecasts++;
    })); } while (performance.now() < finishAt);
  })();
  const radarWork = (async () => {
    do {
      const raw = Uint8Array.from(radarPayload.body).buffer;
      await workerJob(workerModule(import.meta.url, 'radar-worker'), { raw, site: 'CONUS', source: radar.resource.url,
        sourceHash: radarPayload.sha256, window: { earliest: marker.capturedAt - 4 * 3600_000, latest: marker.capturedAt + 30_000 } }, abort.signal, [raw]);
      counts.radar++;
    } while (performance.now() < finishAt);
  })();
  const bulk = (async () => {
    app.notams.refresh(); await app.notams.settled();
    assert.equal(app.notams.reconciliation?.pending, true, JSON.stringify(app.notams.status));
    now += 180_001; app.notams.refresh(); await app.notams.settled();
    assert.equal(app.notams.status.state, 'ready', JSON.stringify(app.notams.status)); counts.bulk++;
  })();
  await Promise.all([forecasts, radarWork, bulk, samples]);
  const profile = await samples;
  assert.equal(profile.failures, 0); assert.equal(externalRequests, 0);
  assert.deepEqual(await readFile(budgetPath), originalBudget);
  await writeFile(resolve(output), JSON.stringify({ outcome: 'passed', source: { marker, generation: sourceGeneration,
    admissionSha256: createHash('sha256').update(originalBudget).digest('hex'), bulk: archive.sha256,
    native: sources, radar: radarPayload.sha256 }, durationSeconds: (performance.now() - started) / 1000, counts,
    profile, peakRssBytes, runtime: app.metrics.status, externalRequests, fixtureRequests, originalAdmissionUnchanged: true,
    limitation: 'Captured production inputs, fixed source clock and synthetic bulk schedule; sustained offline overlap, not a live upstream soak.' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ output, counts, peakRssBytes, profile, externalRequests }));
} catch (cause) {
  await writeFile(resolve(output), JSON.stringify({ outcome: 'failed', counts, peakRssBytes, externalRequests, fixtureRequests,
    error: cause instanceof Error ? cause.message : String(cause), runtime: app.metrics.status }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  throw cause;
} finally { clearInterval(memory); abort.abort(); await sampler?.terminate(); await app.close(); }
