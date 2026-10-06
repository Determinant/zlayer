import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { NotamRecord } from '@zlayer/contracts';
import { createNotamXmlParser } from './info-server/notams/normalize';
import { NotamStore } from './info-server/notams/store';
import { fixtureWeather } from '../test/fixtures/info-server';
import { notice, bulkXml } from '../test/fixtures/notams';
import { WEATHER_NOW } from '../test/fixtures/awc-advisories';

// Offline invented source replay. Real parsers, workers, disk publications and
// HTTP delivery; small weather grids do not reproduce production memory demand.
const [output, countText = '90000'] = process.argv.slice(2), count = Number(countText);
if (!output || !Number.isInteger(count) || count < 1 || count > 150000) throw new Error('Usage: node --import tsx tools/replay-info-workload.ts OUTPUT.json [RECORDS=90000]');
const directory = await mkdtemp(join(tmpdir(), 'info-replay-'));
let now = WEATHER_NOW - 86400_000;
const sourceRecords = Array.from({ length: count }, (_, i) => {
  const id = String(1757600000000001 + i), location = i % 1000 === 0 ? 'SJC' : `X${(i % 1000).toString().padStart(3, '0')}`;
  return notice({ id, sourceId: `NMS_ID_${id}`, updatedAt: WEATHER_NOW - 60000, issuedAt: WEATHER_NOW - 60000,
    locations: [location], icaoLocations: location === 'SJC' ? ['KSJC'] : [] });
});
const xml = bulkXml(sourceRecords, WEATHER_NOW), zipped = gzipSync(xml), normalized: NotamRecord[] = [];
const parser = createNotamXmlParser(record => normalized.push(record));
for (let offset = 0; offset < xml.length; offset += 65536) parser.write(xml.slice(offset, offset + 65536));
parser.finish();
const state = join(directory, 'notams'), seed = new NotamStore(join(state, 'staging'), 'staging', () => now);
await seed.restore(); await seed.reserve('bulk'); now = WEATHER_NOW;
await seed.publish({ schemaVersion: 2, environment: 'staging', records: normalized, complete: true,
  checkedAt: now - 180000, watermark: now - 180000, baselineAt: now - 86400_000, fullSyncAt: now - 86400_000 }); await seed.close();
let sourceRequests = 0, bulkRequests = 0;
const app = await fixtureWeather(join(directory, 'weather'), { now: () => now, notamWait: async ms => { now += ms; },
  notams: { enabled: true, environment: 'staging', directory: state, credentials: { clientId: 'offline', clientSecret: 'offline' } },
  notamFetch: async input => {
    sourceRequests++; now += 1001;
    const path = new URL(String(input)).pathname;
    if (path === '/v1/auth/token') return Response.json({ access_token: 'offline', expires_in: '1799', token_type: 'BearerToken' });
    if (path.endsWith('/il')) { bulkRequests++; return Response.json({ status: 'Success', data: { url: '/v1/content/replay' } }); }
    if (path.endsWith('/content/replay')) return new Response(zipped);
    return Response.json({ status: 'Success', data: { aixm: [] } });
  } });
try {
  await app.notams.restore();
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  // A separate client process observes server pauses instead of having its own
  // sampling timers paused by the same event loop it is supposed to measure.
  const sampled = join(directory, 'profile.json');
  const client = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./profile-info-server.ts', import.meta.url)),
    `http://127.0.0.1:${address.port}`, sampled, '45', '4'], { stdio: ['ignore', 'inherit', 'inherit'] });
  const reads = new Promise<void>((resolve, reject) => {
    client.once('error', reject); client.once('exit', code => code === 0 ? resolve() : reject(new Error(`Profiler exited ${code}`)));
  });
  void reads.catch(() => {});
  app.forecasts.refresh(); app.notams.refresh();
  await app.notams.settled();
  assert.equal(app.notams.reconciliation?.pending, true, JSON.stringify(app.notams.status));
  now += 180001; app.notams.refresh(); await app.notams.settled();
  assert.equal(app.notams.status.state, 'ready'); assert.equal(bulkRequests, 1);
  await Promise.all([app.forecasts.close(), reads]);
  const profile = JSON.parse(await readFile(sampled, 'utf8'));
  await writeFile(output, JSON.stringify({ fixture: { records: count, bulkRequests, sourceRequests,
    compressedBytes: zipped.length, externalRequests: 0, limitation: 'Invented notices and small weather grids; not a production memory soak' },
    profile, runtime: app.metrics.status }, null, 2) + '\n');
  console.log(JSON.stringify({ output, latencyMs: profile.latencyMs, operations: app.metrics.status.operations,
    eventLoop: app.metrics.status.eventLoop, memory: app.metrics.status.memory }));
} finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
