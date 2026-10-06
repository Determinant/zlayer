import assert from 'node:assert/strict';
import test from 'node:test';
import { createHook } from 'node:async_hooks';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { request, type ClientRequest, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createInfoServer } from '../tools/info-server/server';
import { resourceFor } from '../tools/info-server/routes';
import { digest } from '../tools/info-server/upstream';

const path = '/api/weather/metars.geojson?ids=KSFO';
function read(url: string, method = 'GET', encoding = 'gzip') {
  return new Promise<{ status: number; headers: IncomingMessage['headers']; body: Buffer }>((resolve, reject) => {
    const req = request(url, { method, headers: { 'Accept-Encoding': encoding } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
}
async function listen(app: Awaited<ReturnType<typeof createInfoServer>>) {
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

test('cached reports share saved gzip across readers, HEAD and restart, and repair damaged encodings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weather-delivery-'));
  let calls = 0, compressions = 0, revision = 1;
  const options = { directory, startUpdates: false, spacing: 0, fetch: async () => {
    calls++; return Response.json({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [-122, 37] },
      properties: { revision, text: 'weather'.repeat(100_000) } }] });
  } };
  let app = await createInfoServer(options);
  const hook = createHook({ init(_id, type) { if (type === 'ZLIB') compressions++; } });
  try {
    let origin = await listen(app);
    hook.enable();
    const first = await read(origin + path);
    assert.equal(first.status, 200); assert.equal(first.headers['content-encoding'], 'gzip');
    assert.equal(compressions, 1, 'publication prepares the only compressed representation');
    for (const result of await Promise.all(Array.from({ length: 24 }, () => read(origin + path)))) {
      assert.equal(result.status, 200); assert.deepEqual(result.body, first.body);
      assert.equal(result.headers['x-weather-checked-at'], first.headers['x-weather-checked-at']);
      assert.equal(result.headers['x-weather-cache'], 'HIT');
    }
    const head = await read(origin + path, 'HEAD');
    assert.equal(head.body.length, 0); assert.equal(head.headers['content-length'], first.headers['content-length']);
    assert.equal(compressions, 1); assert.equal(calls, 1);
    await app.close(); app = await createInfoServer(options); origin = await listen(app);
    const restored = await read(origin + path);
    assert.deepEqual(restored.body, first.body); assert.equal(compressions, 1); assert.equal(calls, 1);
    const saved = await app.cache.open(resourceFor(path), true); assert.ok(saved?.gzip); await saved.handle.close();
    const file = await open(saved.entry.file, 'r+');
    try { await file.write(Buffer.from([0]), 0, 1, saved.offset); await file.utimes(new Date(), new Date(Date.now() + 2000)); }
    finally { await file.close(); }
    revision++;
    const repaired = await read(origin + path);
    assert.equal(repaired.status, 200); assert.equal(calls, 2); assert.equal(compressions, 2);
    hook.disable();
    assert.equal(JSON.parse(gunzipSync(repaired.body).toString()).features[0].properties.revision, 2);
    assert.equal(digest(gunzipSync(repaired.body)), repaired.headers['x-weather-sha256']);
  } finally { hook.disable(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('optional persistence failure still shares one acquisition and compression across waiting clients', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weather-delivery-fallback-'));
  let calls = 0, compressions = 0, finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const app = await createInfoServer({ directory, maxBytes: 8, startUpdates: false, spacing: 0, fetch: async () => {
    calls++; await gate; return Response.json({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [-122, 37] },
      properties: { text: 'weather'.repeat(1000) } }] });
  } });
  const hook = createHook({ init(_id, type) { if (type === 'ZLIB') compressions++; } });
  try {
    const origin = await listen(app); hook.enable();
    let admitted = 0, allAdmitted!: () => void;
    const ready = new Promise<void>(resolve => { allAdmitted = resolve; });
    const get = app.cache.get.bind(app.cache);
    app.cache.get = async (...args) => { if (++admitted === 20) allAdmitted(); return get(...args); };
    const requests = Array.from({ length: 20 }, () => read(origin + path));
    await ready; finish();
    const responses = await Promise.all(requests);
    assert.ok(responses.every(result => result.status === 200 && result.body.equals(responses[0]!.body)));
    assert.equal(calls, 1); assert.equal(compressions, 1); assert.equal(app.cache.stats.entries, 0);
  } finally { finish(); hook.disable(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('slow weather readers are bounded across query/artifact routes while health and NOTAM delivery remain available', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weather-delivery-load-')); let calls = 0;
  const app = await createInfoServer({ directory, startUpdates: false, fetch: async () => { calls++; throw new Error('No source expected'); } });
  const clients: ClientRequest[] = [], bodies: IncomingMessage[] = [];
  try {
    const origin = await listen(app), checkedAt = Date.now();
    const artifact = `/api/weather/grids/clouds/1791230400000-0-0-${'a'.repeat(64)}.zwp.gz`;
    for (const url of [path, artifact]) {
      const body = Buffer.alloc(url === path ? 4_000_000 : 8_000_000, 120);
      await app.cache.put(resourceFor(url), { body, sha256: digest(body), checkedAt, status: 200,
        headers: { 'content-type': 'application/octet-stream' } });
    }
    const statuses = await Promise.all(Array.from({ length: 48 }, (_, index) => new Promise<number>((resolve, reject) => {
      const client = request(origin + (index % 2 ? path : artifact), { headers: { 'Accept-Encoding': 'identity' } }, response => {
        bodies.push(response); response.on('error', () => {}); response.pause();
        if (response.statusCode === 503) assert.equal(response.headers['retry-after'], '1');
        resolve(response.statusCode!);
      });
      clients.push(client); client.on('error', reject); client.end();
    })));
    assert.ok(statuses.includes(200)); assert.ok(statuses.includes(503));
    assert.ok(statuses.filter(status => status === 200).length <= 32);
    for (const url of ['/api/weather/healthz', '/api/notams/healthz']) assert.equal((await read(origin + url)).status, 200);
    const tfr = await read(origin + '/api/notams/tfrs');
    assert.deepEqual(JSON.parse(tfr.body.toString()), { error: 'tfrs-unavailable' }, 'weather load cannot consume NOTAM delivery capacity');
    assert.equal(calls, 0);
    for (const body of bodies) body.destroy(); for (const client of clients) client.destroy();
    for (let i = 0; ; i++) {
      const response = await read(origin + artifact, 'HEAD');
      if (response.status === 200) break;
      assert.ok(i < 100, 'capacity must recover after readers disconnect');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  } finally {
    for (const body of bodies) body.destroy(); for (const client of clients) client.destroy();
    await app.close(); await rm(directory, { recursive: true, force: true });
  }
});
